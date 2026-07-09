import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class StdioTransport extends EventEmitter {
    constructor(command, args, options = {}) {
        super();
        this.command = command;
        this.args = args;
        this.options = options;
        this.process = null;
        this.buffer = '';
    }

    start() {
        this.process = spawn(this.command, this.args, this.options);
        
        this.process.stdout.on('data', (chunk) => {
            this.buffer += chunk.toString();
            this.processBuffer();
        });

        this.process.stderr.on('data', (chunk) => {
            // Simply log or emit stderr if needed
            // console.error(`[StdioTransport] stderr: ${chunk.toString()}`);
        });

        this.process.on('close', (code) => {
            this.emit('close', code);
        });
        
        this.process.on('error', (err) => {
            this.emit('error', err);
        });
    }

    processBuffer() {
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const message = JSON.parse(line);
                    this.emit('message', message);
                } catch (e) {
                    console.error('[StdioTransport] parse error', e, line);
                }
            }
        }
    }

    async send(message) {
        if (!this.process) {
            throw new Error('Transport not started');
        }
        const data = JSON.stringify(message) + '\n';
        this.process.stdin.write(data);
    }
    
    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}

export class SseTransport extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.controller = null;
        this.postUrl = null;
    }

    async start() {
        this.controller = new AbortController();
        try {
            const response = await fetch(this.url, {
                signal: this.controller.signal,
                headers: {
                    'Accept': 'text/event-stream'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            this.readStream(response.body).catch(err => {
                if (err.name !== 'AbortError') {
                    this.emit('error', err);
                }
            });
        } catch (error) {
            this.emit('error', error);
        }
    }

    async readStream(body) {
        const decoder = new TextDecoder();
        let buffer = '';
        let eventType = 'message';
        let data = [];

        try {
            for await (const chunk of body) {
                buffer += decoder.decode(chunk, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line.startsWith('event:')) {
                        eventType = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        const dataContent = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
                        data.push(dataContent);
                    } else if (line === '') {
                        if (data.length > 0) {
                            this.handleEvent(eventType, data.join('\n'));
                            data = [];
                        }
                        eventType = 'message';
                    }
                }
            }
        } finally {
            this.emit('close');
        }
    }

    handleEvent(eventType, eventData) {
        if (eventType === 'endpoint') {
            try {
                this.postUrl = new URL(eventData, this.url).toString();
                this.emit('ready');
            } catch (e) {
                this.emit('error', new Error(`Invalid endpoint URL: ${eventData}`));
            }
        } else if (eventType === 'message') {
            try {
                const message = JSON.parse(eventData);
                this.emit('message', message);
            } catch (e) {
                console.error('[SseTransport] parse error', e, eventData);
            }
        }
    }

    async send(message) {
        if (!this.postUrl) {
            throw new Error('SseTransport not ready (no POST endpoint received)');
        }
        
        const response = await fetch(this.postUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        });
        
        if (!response.ok) {
            throw new Error(`Failed to send message: HTTP ${response.status}`);
        }
    }
    
    stop() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
    }
}
