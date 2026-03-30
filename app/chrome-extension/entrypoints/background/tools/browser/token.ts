import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { networkCaptureStartTool } from './network-capture-web-request';

interface GetTokenToolParams {
  matchUrl?: string;
  headerName?: string;
  exactMatch?: boolean;
  tabId?: number;
  url?: string;
}

const DEFAULT_NAVIGATION_URL = 'https://episerver.zendesk.com/agent/search/1';
const DEFAULT_MATCH_URL = 'api/graphql';

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

    console.log('[token] execute', {
      matchUrl,
      headerName,
      exactMatch,
      tabId,
      url,
    });

    if (typeof matchUrl !== 'string') {
      console.error('[token] invalid matchUrl type', { matchUrlType: typeof matchUrl });
      return createErrorResponse('Parameter "matchUrl" must be a string when provided');
    }

    // Step 1: Create a new tab
    let targetTabId: number;
    if (tabId && Number.isFinite(tabId)) {
      targetTabId = tabId;
    } else {
      const newTab = await chrome.tabs.create({ url, active: true });
      if (!newTab.id) {
        console.error('[token] failed to create new tab');
        return createErrorResponse('Failed to create new tab');
      }
      targetTabId = newTab.id;
    }

    console.log('[token] using tab', { targetTabId });

    // Step 2: Close other tabs in the current window
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id) {
        const allTabs = await chrome.tabs.query({ windowId: currentWindow.id });
        const tabsToClose = allTabs.filter((tab) => tab.id && tab.id !== targetTabId);
        if (tabsToClose.length > 0) {
          const tabIdsToClose = tabsToClose.map((tab) => tab.id!);
          await chrome.tabs.remove(tabIdsToClose);
        }
      }
    } catch (error) {
      // Log error but continue - closing tabs is not critical
      console.error('[token] error closing other tabs', error);
    }

    // Wait for the new tab to load if it was just created
    if (!tabId || !Number.isFinite(tabId)) {
      console.log('[token] waiting for initial page load', { targetTabId, url });
      await this.waitForPageLoad(targetTabId, url, 15000);
    } else {
      // If using existing tab, navigate to URL
      console.log('[token] navigating existing tab and waiting', { targetTabId, url });
      await chrome.tabs.update(targetTabId, { url, active: true });
      await this.waitForPageLoad(targetTabId, url, 15000);
    }

    let captureInfo = networkCaptureStartTool.captureData.get(targetTabId);
    if (!captureInfo) {
      console.log('[token] capture not running; attempting auto-start', { targetTabId });
      const autoStarted = await this.startCapture(targetTabId);

      if (!autoStarted) {
        console.error('[token] auto-start capture failed', { targetTabId });
        return createErrorResponse(
          'Failed to automatically navigate and start capture. Please start chrome_network_capture_start manually and retry.',
        );
      }

      captureInfo = networkCaptureStartTool.captureData.get(targetTabId);
      if (!captureInfo) {
        console.error('[token] capture start returned but no captureInfo found', { targetTabId });
        return createErrorResponse(
          'Capture did not initialize properly. Please retry after verifying network capture is running.',
        );
      }
    }

    console.log('[token] capture active', {
      targetTabId,
      requestCount: Object.keys(captureInfo.requests || {}).length,
    });

    const matchingRequest = await this.waitForMatchingRequest({
      tabId: targetTabId,
      matchUrl,
      exactMatch,
      timeoutMs: 10000,
    });

    if (!matchingRequest) {
      console.error('[token] timed out waiting for matching request', {
        targetTabId,
        matchUrl,
        exactMatch,
        headerName,
      });
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
      console.log('[token] header found', {
        headerName,
        url: (matchingRequest as any).url,
        method: (matchingRequest as any).method,
      });
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

    console.error('[token] header not found on captured request', {
      headerName,
      matchUrl,
      exactMatch,
      url: (matchingRequest as any)?.url,
      method: (matchingRequest as any)?.method,
      availableHeaderNames: Object.keys(headers || {}),
    });
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

  private async startCapture(tabId: number): Promise<boolean> {
    try {
      const startResult = await networkCaptureStartTool.startCaptureOnExistingTab(tabId, {
        includeStatic: false,
      });

      if (!startResult.success) {
        console.error('[token] startCaptureOnExistingTab reported failure', {
          tabId,
          startResult,
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error('[token] error starting capture', { tabId }, error);
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
