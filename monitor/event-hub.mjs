export class MonitorEventHub {
  constructor({ retention = 2000 } = {}) {
    this.retention = retention;
    this.sequence = 0;
    this.events = [];
    this.clients = new Set();
  }

  publish(type, payload, meta = {}) {
    const event = {
      sequence: ++this.sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
      meta,
    };
    this.events.push(event);
    if (this.events.length > this.retention) this.events.splice(0, this.events.length - this.retention);
    for (const client of this.clients) client(event);
    return event;
  }

  after(sequence = 0) { return this.events.filter((event) => event.sequence > sequence); }

  subscribe(listener) {
    this.clients.add(listener);
    return () => this.clients.delete(listener);
  }
}

export function encodeSse(event) {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

