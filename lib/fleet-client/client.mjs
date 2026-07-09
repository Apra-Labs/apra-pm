export class McpClient {
    constructor(transport) {
        this.transport = transport;
        this.pendingRequests = new Map();
        this.nextId = 1;

        this.transport.on('message', (message) => {
            this.handleMessage(message);
        });

        this.transport.on('close', () => {
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(new Error('Transport closed'));
            }
            this.pendingRequests.clear();
        });

        this.transport.on('error', (err) => {
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(err);
            }
            this.pendingRequests.clear();
        });
    }

    handleMessage(message) {
        if (message.jsonrpc === '2.0' && 'id' in message) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                if ('error' in message) {
                    const errMsg = message.error?.message || JSON.stringify(message.error);
                    pending.reject(new Error(errMsg));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }

    async callTool(name, args) {
        const id = this.nextId++;
        const message = {
            jsonrpc: "2.0",
            id: id,
            method: "tools/call",
            params: {
                name: name,
                arguments: args
            }
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.transport.send(message).catch(err => {
                this.pendingRequests.delete(id);
                reject(err);
            });
        });
    }
}
