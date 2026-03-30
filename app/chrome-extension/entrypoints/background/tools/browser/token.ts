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

    console.log('[token] execute', { matchUrl, headerName, exactMatch, tabId, url });

    if (typeof matchUrl !== 'string') {
      console.error('[token] invalid matchUrl type', { matchUrlType: typeof matchUrl });
      return createErrorResponse('Parameter "matchUrl" must be a string when provided');
    }

    try {
      // Step 1: Resolve or create the target tab
      const { targetTabId, needsNavigation } = await this.resolveTab(tabId, url);

      // Step 2: Start capture BEFORE navigation so we don't miss early requests
      await this.ensureCaptureRunning(targetTabId);
      console.log('[token] capture ready', { targetTabId, needsNavigation });

      // Step 3: If already on the right page, check existing capture data first
      if (!needsNavigation) {
        const existing = this.findHeaderInCapture(targetTabId, matchUrl, exactMatch, headerName);
        if (existing) {
          console.log('[token] header found in existing capture data', { headerName });
          await this.stopCapture(targetTabId);
          return this.buildSuccessResponse(existing.value, headerName, existing.request);
        }
        // No match — reload to trigger fresh requests
        console.log('[token] no match in existing data, reloading page', { targetTabId });
        await chrome.tabs.reload(targetTabId);
      } else {
        // Navigate to trigger network requests (capture is already listening)
        console.log('[token] navigating to target URL', { targetTabId, url });
        await chrome.tabs.update(targetTabId, { url, active: true });
      }

      await this.waitForPageLoad(targetTabId, url, 15000);

      // Step 4: Wait for header to appear in captured requests
      const result = await this.waitForHeader({
        tabId: targetTabId,
        matchUrl,
        exactMatch,
        headerName,
        timeoutMs: 15000,
      });

      if (result) {
        console.log('[token] header found', {
          headerName,
          url: result.request.url,
          method: result.request.method,
        });
        await this.stopCapture(targetTabId);
        return this.buildSuccessResponse(result.value, headerName, result.request);
      }

      // Step 5: Retry — restart capture cleanly and reload the page
      console.log('[token] first attempt timed out, retrying with fresh capture', { targetTabId });
      await this.restartCapture(targetTabId);
      await chrome.tabs.reload(targetTabId);
      await this.waitForPageLoad(targetTabId, url, 15000);

      const retryResult = await this.waitForHeader({
        tabId: targetTabId,
        matchUrl,
        exactMatch,
        headerName,
        timeoutMs: 15000,
      });

      if (retryResult) {
        console.log('[token] header found on retry', {
          headerName,
          url: retryResult.request.url,
          method: retryResult.request.method,
        });
        await this.stopCapture(targetTabId);
        return this.buildSuccessResponse(retryResult.value, headerName, retryResult.request);
      }

      console.error('[token] failed to find header after retry', {
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
                'Timed out waiting for the matching request after retry. Ensure the page triggers the expected request.',
              headerName,
              matchUrl,
              exactMatch,
            }),
          },
        ],
        isError: true,
      };
    } catch (error: any) {
      console.error('[token] unexpected error', error);
      return createErrorResponse(`Token extraction failed: ${error.message || String(error)}`);
    }
  }

  // ─── Tab resolution ───────────────────────────────────────────────────────────

  private async resolveTab(
    tabId: number | undefined,
    url: string,
  ): Promise<{ targetTabId: number; needsNavigation: boolean }> {
    // Caller provided an explicit tabId
    if (tabId && Number.isFinite(tabId)) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const onSamePage = this.isSamePageUrl(tab.url || '', url);
        console.log('[token] using provided tab', {
          targetTabId: tabId,
          currentUrl: tab.url,
          needsNavigation: !onSamePage,
        });
        return { targetTabId: tabId, needsNavigation: !onSamePage };
      } catch {
        console.warn('[token] provided tabId not found, creating new tab', { tabId });
      }
    }

    // Try to find an existing tab on the same origin to avoid tab proliferation
    const existingTab = await this.findTabByOrigin(url);
    if (existingTab?.id) {
      await chrome.tabs.update(existingTab.id, { active: true });
      const onSamePage = this.isSamePageUrl(existingTab.url || '', url);
      console.log('[token] reusing existing tab', {
        targetTabId: existingTab.id,
        currentUrl: existingTab.url,
        needsNavigation: !onSamePage,
      });
      return { targetTabId: existingTab.id, needsNavigation: !onSamePage };
    }

    // Create a new tab at about:blank so capture can attach before any navigation
    const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
    if (!newTab.id) {
      throw new Error('Failed to create new tab');
    }
    console.log('[token] created new tab', { targetTabId: newTab.id });
    return { targetTabId: newTab.id, needsNavigation: true };
  }

  private isSamePageUrl(currentUrl: string, targetUrl: string): boolean {
    try {
      const current = new URL(currentUrl);
      const target = new URL(targetUrl);
      return current.origin === target.origin && current.pathname === target.pathname;
    } catch {
      return currentUrl === targetUrl;
    }
  }

  private async findTabByOrigin(url: string): Promise<chrome.tabs.Tab | null> {
    try {
      const targetOrigin = new URL(url).origin;
      const allTabs = await chrome.tabs.query({});
      return (
        allTabs.find((tab) => {
          try {
            return tab.url && new URL(tab.url).origin === targetOrigin;
          } catch {
            return false;
          }
        }) || null
      );
    } catch {
      return null;
    }
  }

  // ─── Capture management ───────────────────────────────────────────────────────

  private async ensureCaptureRunning(tabId: number): Promise<void> {
    const existing = networkCaptureStartTool.captureData.get(tabId);
    if (existing) {
      console.log('[token] capture already running', {
        tabId,
        requestCount: Object.keys(existing.requests || {}).length,
      });
      return;
    }

    console.log('[token] starting capture', { tabId });
    const result = await networkCaptureStartTool.startCaptureOnExistingTab(tabId, {
      includeStatic: false,
    });

    if (!result.success) {
      throw new Error(`Failed to start network capture: ${result.message}`);
    }
  }

  private async restartCapture(tabId: number): Promise<void> {
    await this.stopCapture(tabId);
    const result = await networkCaptureStartTool.startCaptureOnExistingTab(tabId, {
      includeStatic: false,
    });
    if (!result.success) {
      throw new Error(`Failed to restart network capture: ${result.message}`);
    }
  }

  private async stopCapture(tabId: number): Promise<void> {
    if (networkCaptureStartTool.captureData.has(tabId)) {
      console.log('[token] stopping capture', { tabId });
      await networkCaptureStartTool.stopCapture(tabId);
    }
  }

  // ─── Request / header matching ────────────────────────────────────────────────

  private findMatchingRequests(tabId: number, matchUrl: string, exactMatch: boolean): any[] {
    const captureInfo = networkCaptureStartTool.captureData.get(tabId);
    if (!captureInfo) return [];

    return Object.values(captureInfo.requests || {})
      .filter((r) => {
        if (!r?.url) return false;
        return exactMatch ? r.url === matchUrl : r.url.includes(matchUrl);
      })
      .sort((a, b) => (b.requestTime || 0) - (a.requestTime || 0));
  }

  private extractHeader(request: any, headerName: string): string | null {
    const headerKey = headerName.toLowerCase();
    const headers = request.requestHeaders || request.specificRequestHeaders || {};
    for (const name of Object.keys(headers || {})) {
      if (name.toLowerCase() === headerKey) {
        return headers[name] || null;
      }
    }
    return null;
  }

  private findHeaderInCapture(
    tabId: number,
    matchUrl: string,
    exactMatch: boolean,
    headerName: string,
  ): { value: string; request: any } | null {
    const matches = this.findMatchingRequests(tabId, matchUrl, exactMatch);
    for (const request of matches) {
      const value = this.extractHeader(request, headerName);
      if (value) return { value, request };
    }
    return null;
  }

  private async waitForHeader(opts: {
    tabId: number;
    matchUrl: string;
    exactMatch: boolean;
    headerName: string;
    timeoutMs: number;
  }): Promise<{ value: string; request: any } | null> {
    const { tabId, matchUrl, exactMatch, headerName, timeoutMs } = opts;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const result = this.findHeaderInCapture(tabId, matchUrl, exactMatch, headerName);
      if (result) return result;
      await this.delay(300);
    }
    return null;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private buildSuccessResponse(token: string, headerName: string, request: any): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            token,
            headerName,
            url: request.url,
            method: request.method,
            requestTime: request.requestTime,
          }),
        },
      ],
      isError: false,
    };
  }

  private async waitForPageLoad(tabId: number, expectedUrl: string, timeoutMs: number) {
    const start = Date.now();
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(expectedUrl).origin;
    } catch {
      expectedOrigin = expectedUrl;
    }

    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          try {
            const tabOrigin = tab.url ? new URL(tab.url).origin : '';
            if (tabOrigin === expectedOrigin) return;
          } catch {
            if (tab.url?.startsWith(expectedUrl)) return;
          }
        }
      } catch {
        // Tab may have been closed
        return;
      }
      await this.delay(300);
    }
    console.warn('[token] page load wait timed out', { tabId, expectedUrl, timeoutMs });
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const getTokenTool = new GetTokenTool();
