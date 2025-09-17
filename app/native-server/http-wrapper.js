#!/usr/bin/env node

const http = require('http');
const url = require('url');

// Import MCP client
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Configuration
const PORT = 12307;
const MCP_SERVER_URL = 'http://127.0.0.1:12306/mcp';

// On-demand MCP client usage with simple in-memory cache
// Cache to avoid excessive calls to MCP server
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const responseCache = new Map(); // key -> { value, expiresAt }
const inflightRequests = new Map(); // key -> Promise

function getFromCache(cacheKey) {
  const entry = responseCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.value;
  responseCache.delete(cacheKey);
  return null;
}

function setCache(cacheKey, value, ttlMs = CACHE_TTL_MS) {
  responseCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
}

// Create ephemeral MCP client for a single request and close after done
async function callMcpToolOnce(toolName, toolArgs) {
  const client = new Client(
    { name: 'HTTP-Wrapper-Client', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {});
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: toolArgs }, undefined, {
      timeout: 30000,
    });
    return result;
  } finally {
    try {
      await client.close();
    } catch (error) {
      console.log('Error closing MCP client:', error.message);
    }
  }
}

// No generic send function needed in on-demand mode for now

// HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (pathname === '/ping' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'HTTP Wrapper Server is running',
        mcpServerUrl: MCP_SERVER_URL,
        mcpClientMode: 'on-demand',
        cache: { entries: responseCache.size, ttlMs: CACHE_TTL_MS },
        note: 'Connects to MCP server only when handling a request and disconnects after',
      }),
    );
    return;
  }

  // Get cookie tool endpoint
  if (pathname === '/tools/get-cookie' && method === 'POST') {
    try {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const { url: targetUrl } = JSON.parse(body);

          if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'URL parameter is required' }));
            return;
          }

          console.log(`Get cookie request for URL: ${targetUrl}`);

          // Create MCP tool call message
          const mcpMessage = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'chrome_get_cookie',
              arguments: {
                url: targetUrl,
              },
            },
          };

          // Cache key for this call
          const cacheKey = `get-cookie:${targetUrl}`;
          const cached = getFromCache(cacheKey);
          if (cached) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                message: `Cookies retrieved from ${targetUrl} (cache)`,
                response: cached,
                request: mcpMessage,
                cache: { hit: true },
              }),
            );
            return;
          }

          try {
            // Deduplicate in-flight requests for the same key
            let promise = inflightRequests.get(cacheKey);
            if (!promise) {
              promise = (async () => {
                // Send request to MCP server using ephemeral client
                const response = await callMcpToolOnce(
                  mcpMessage.params.name,
                  mcpMessage.params.arguments,
                );
                setCache(cacheKey, response);
                return response;
              })();
              inflightRequests.set(cacheKey, promise);
            }
            const response = await promise.finally(() => inflightRequests.delete(cacheKey));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                message: `Cookies retrieved from ${targetUrl}`,
                response: response,
                request: mcpMessage,
                cache: { hit: false },
              }),
            );
          } catch (mcpError) {
            console.error('MCP client communication error:', mcpError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Failed to communicate with MCP server',
                details: mcpError.message,
                suggestion: 'Make sure the MCP server is running at ' + MCP_SERVER_URL,
              }),
            );
          }
        } catch (parseError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
        }
      });
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // List available tools
  if (pathname === '/tools' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        tools: [
          {
            name: 'get-cookie',
            endpoint: '/tools/get-cookie',
            method: 'POST',
            description: 'Get cookies from a specified website',
            parameters: {
              url: 'string - URL of the website to get cookies from',
            },
            note: 'On-demand MCP connection (connect per request) at ' + MCP_SERVER_URL,
            status: 'on-demand',
            cache: { ttlMs: CACHE_TTL_MS },
          },
        ],
      }),
    );
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// Start server
server.listen(PORT, async () => {
  console.log(`HTTP Wrapper Server running on http://127.0.0.1:${PORT}`);
  console.log('Available endpoints:');
  console.log(`  GET  /ping - Health check`);
  console.log(`  GET  /tools - List available tools`);
  console.log(`  POST /tools/get-cookie - Get cookies from a website`);
  console.log('');
  console.log('Note: MCP connections are established on-demand per request');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log the error
});
