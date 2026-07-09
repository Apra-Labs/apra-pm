import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { StdioTransport, SseTransport } from '../lib/fleet-client/transport.mjs';
import { McpClient } from '../lib/fleet-client/client.mjs';

test('McpClient - callTool successfully', async () => {
    class MockTransport extends EventEmitter {
        async send(message) {
            setTimeout(() => {
                this.emit('message', {
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { content: 'test result' }
                });
            }, 10);
        }
    }

    const transport = new MockTransport();
    const client = new McpClient(transport);

    const result = await client.callTool('my_tool', { foo: 'bar' });
    assert.deepStrictEqual(result, { content: 'test result' });
});

test('McpClient - callTool error', async () => {
    class MockTransport extends EventEmitter {
        async send(message) {
            setTimeout(() => {
                this.emit('message', {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { message: 'tool failed' }
                });
            }, 10);
        }
    }

    const transport = new MockTransport();
    const client = new McpClient(transport);

    await assert.rejects(
        client.callTool('my_tool', { foo: 'bar' }),
        /tool failed/
    );
});

test('StdioTransport - sending and receiving', async () => {
    const script = `process.stdin.on('data', (data) => { const lines = data.toString().split(/\\r?\\n/).filter(x => x.trim()); for (const line of lines) { const req = JSON.parse(line); const res = { jsonrpc: '2.0', id: req.id, result: 'echo' }; console.log(JSON.stringify(res)); } });`;
    const transport = new StdioTransport(process.execPath, ['-e', script]);
    transport.start();

    const client = new McpClient(transport);
    const result = await client.callTool('echo', {});
    assert.strictEqual(result, 'echo');

    transport.stop();
});

test('SseTransport - connects and receives endpoint, then sends message', async () => {
    let sseRes = null;
    const server = http.createServer(async (req, res) => {
        if (req.url === '/sse') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            sseRes = res;
            res.write('event: endpoint\n');
            res.write('data: /message\n\n');
        } else if (req.url === '/message' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
            }
            const parsed = JSON.parse(body);
            res.writeHead(202).end();

            if (sseRes) {
                const responseMsg = { jsonrpc: '2.0', id: parsed.id, result: 'ok' };
                sseRes.write('event: message\n');
                sseRes.write(`data: ${JSON.stringify(responseMsg)}\n\n`);
            }
        } else {
            res.writeHead(404).end();
        }
    });

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}/sse`;

    const transport = new SseTransport(url);
    
    const readyPromise = new Promise(resolve => transport.on('ready', resolve));
    transport.start();
    await readyPromise;

    const client = new McpClient(transport);
    const result = await client.callTool('test', {});
    assert.strictEqual(result, 'ok');

    transport.stop();
    server.close();
});
