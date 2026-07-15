#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb, resolveDbPath } from '../store/db.js';
import { registerAllTools } from './tools.js';

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);

  const server = new McpServer({
    name: 'collab-engine',
    version: '0.1.0',
  });

  registerAllTools(server, db);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[collab] fatal:', err);
  process.exit(1);
});
