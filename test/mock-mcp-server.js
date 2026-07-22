#!/usr/bin/env node
'use strict';
// テスト用の最小 MCP サーバ(stdio)。ハブの接続・ツール列挙・ツール呼び出しを検証するために使う。

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return reply(msg.id, {
        tools: [
          {
            name: 'echo',
            description: '入力された文字列をそのまま返します',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'add',
            description: '2つの数を足します',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') return reply(msg.id, { content: [{ type: 'text', text: `echo: ${args.text}` }] });
      if (name === 'add') return reply(msg.id, { content: [{ type: 'text', text: String(args.a + args.b) }] });
      return reply(msg.id, { content: [{ type: 'text', text: '不明なツール' }], isError: true });
    }
    default:
      if (msg.id !== undefined) reply(msg.id, {});
  }
}
