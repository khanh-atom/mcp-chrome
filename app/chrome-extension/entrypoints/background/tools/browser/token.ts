import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { networkCaptureStartTool } from './network-capture-web-request';
import { logMessage } from '@/common/logger';

interface GetTokenToolParams {
  matchUrl?: string;
  headerName?: string;
  exactMatch?: boolean;
  tabId?: number;
  url?: string;
}

const DEFAULT_NAVIGATION_URL = 'https://episerver.zendesk.com/';
const DEFAULT_MATCH_URL = 'graphql';

class GetTokenTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_TOKEN;

  async execute(args: GetTokenToolParams): Promise<ToolResult> {
    const {
      matchUrl = DEFAULT_MATCH_URL,
      headerName = 'x-csrf-token',
      exactMatch = false,
      tabId,
      url = DEFAULT_NAVIGATION_URL,
    } = args || ({} as any);

    if (typeof matchUrl !== 'string') {
      void logMessage('warn', `[get_token] Invalid matchUrl parameter: ${matchUrl}`);
      return createErrorResponse('Parameter "matchUrl" must be a string when provided');
    }

    const targetTabId = await this.resolveTabId(tabId);
    if (!targetTabId) {
      void logMessage('error', '[get_token] No active tab found while resolving tabId');
      return createErrorResponse('No active tab found');
    }

    let captureInfo = networkCaptureStartTool.captureData.get(targetTabId);
    if (!captureInfo) {
      void logMessage(
        'info',
        `[get_token] No active capture for tab ${targetTabId}. Attempting automatic navigation & capture start.`,
      );

      const autoStarted = await this.navigateAndStartCapture(targetTabId, url);

      if (!autoStarted) {
        return createErrorResponse(
          'Failed to automatically navigate and start capture. Please start chrome_network_capture_start manually and retry.',
        );
      }

      captureInfo = networkCaptureStartTool.captureData.get(targetTabId);
      if (!captureInfo) {
        void logMessage(
          'warn',
          `[get_token] Capture data still missing after auto start for tab ${targetTabId}`,
        );
        return createErrorResponse(
          'Capture did not initialize properly. Please retry after verifying network capture is running.',
        );
      }
    }

    const matchingRequest = await this.waitForMatchingRequest({
      tabId: targetTabId,
      matchUrl,
      exactMatch,
      timeoutMs: 5000,
    });

    if (!matchingRequest) {
      void logMessage(
        'info',
        `[get_token] Timed out waiting for matching request on tab ${targetTabId}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              message:
                'Timed out waiting for the GraphQL request to be captured automatically. Please ensure the page triggers the request.',
              headerName,
              matchUrl,
              exactMatch,
            }),
          },
        ],
        isError: true,
      };
    }

    const headerKey = headerName.toLowerCase();
    const headers =
      (matchingRequest as any).requestHeaders ||
      (matchingRequest as any).specificRequestHeaders ||
      {};
    const value = this.findHeaderCaseInsensitive(headers, headerKey);

    if (value) {
      void logMessage(
        'info',
        `[get_token] Found header ${headerName} on ${matchingRequest.method} ${matchingRequest.url} (tab ${targetTabId})`,
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              token: value,
              headerName,
              url: matchingRequest.url,
              method: matchingRequest.method,
              requestTime: matchingRequest.requestTime,
            }),
          },
        ],
        isError: false,
      };
    }

    void logMessage(
      'info',
      `[get_token] Header ${headerName} not found on matched request for tab ${targetTabId}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            message: `Header "${headerName}" not found on the captured request. Please retry.`,
            headerName,
            matchUrl,
            exactMatch,
          }),
        },
      ],
      isError: true,
    };
  }

  private async resolveTabId(explicitTabId?: number): Promise<number | null> {
    if (explicitTabId && Number.isFinite(explicitTabId)) return explicitTabId;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  }

  private findHeaderCaseInsensitive(
    headers: Record<string, string>,
    targetLower: string,
  ): string | null {
    for (const name of Object.keys(headers || {})) {
      if (name.toLowerCase() === targetLower) {
        return headers[name] || '';
      }
    }
    return null;
  }

  private async navigateAndStartCapture(tabId: number, targetUrl: string): Promise<boolean> {
    try {
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
      await this.waitForPageLoad(tabId, targetUrl, 15000);
      await logMessage(
        'info',
        `[get_token] Navigated tab ${tabId} to ${targetUrl}, starting capture.`,
      );

      const startResult = await networkCaptureStartTool.startCaptureOnExistingTab(tabId, {
        includeStatic: false,
      });

      if (!startResult.success) {
        await logMessage(
          'error',
          `[get_token] Failed to start capture for tab ${tabId}: ${startResult.message || 'unknown error'}`,
        );
        return false;
      }

      await logMessage(
        'info',
        `[get_token] Capture started for tab ${tabId}. Awaiting requests...`,
      );
      return true;
    } catch (error) {
      await logMessage(
        'error',
        `[get_token] navigateAndStartCapture failed for tab ${tabId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async waitForPageLoad(tabId: number, expectedUrl: string, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && tab.url?.startsWith(expectedUrl)) {
        return;
      }
      await this.delay(500);
    }
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForMatchingRequest({
    tabId,
    matchUrl,
    exactMatch,
    timeoutMs,
  }: {
    tabId: number;
    matchUrl: string;
    exactMatch: boolean;
    timeoutMs: number;
  }) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const captureInfo = networkCaptureStartTool.captureData.get(tabId);
      if (captureInfo) {
        const requests = Object.values(captureInfo.requests || {});
        const matched = requests
          .filter((r) => {
            if (!r?.url) return false;
            return exactMatch ? r.url === matchUrl : r.url.includes(matchUrl);
          })
          .sort((a, b) => (b.requestTime || 0) - (a.requestTime || 0));
        if (matched.length > 0) {
          return matched[0];
        }
      }
      await this.delay(500);
    }
    return null;
  }
}

export const getTokenTool = new GetTokenTool();
