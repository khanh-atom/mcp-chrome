# Development Setup Guide

This document outlines the setup and configuration steps for the Chrome MCP Server and Extension.

## Server Setup

### 1. Build and Register Native Messaging Host

Navigate to the server directory and build the project, then register the native messaging host:

```bash
cd app/native-server
npx pnpm run build && npm run register:dev
```

### 2. Configure Chrome Extension Allow List

Add the extension to the allowed origins list. This configuration must be done per browser:

- Update the `allowed_origins` configuration in the native messaging host manifest
- After updating, rebuild and re-register the native messaging host:

```bash
npx pnpm run build && npm run register:dev
```

## Client Setup

_Client setup instructions to be added._
