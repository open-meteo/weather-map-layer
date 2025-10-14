const workerUrl = new URL("./worker/worker.js", import.meta.url);
class WorkerPool {
  constructor() {
    this.workers = [];
    this.nextWorker = 0;
    this.pendingTiles = /* @__PURE__ */ new Map();
    this.resolvers = /* @__PURE__ */ new Map();
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      return;
    }
    const workerCount = navigator.hardwareConcurrency || 4;
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, { type: "module" });
      worker.onmessage = (message) => this.handleMessage(message);
      this.workers.push(worker);
    }
  }
  handleMessage(message) {
    const data = message.data;
    if (data.type === "RT") {
      const resolve = this.resolvers.get(data.key);
      if (resolve) {
        resolve(data.tile);
        this.resolvers.delete(data.key);
        this.pendingTiles.delete(data.key);
      } else {
        console.error(`Unexpected tile response for ${data.key}`);
      }
    }
  }
  getNextWorker() {
    if (this.workers.length === 0) return void 0;
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return worker;
  }
  requestTile(request) {
    const existingPromise = this.pendingTiles.get(request.key);
    if (existingPromise) {
      return existingPromise;
    }
    const worker = this.getNextWorker();
    if (!worker) {
      return Promise.reject(new Error("No workers available (likely running in SSR)"));
    }
    const promise = new Promise((resolve) => {
      this.resolvers.set(request.key, resolve);
    });
    this.pendingTiles.set(request.key, promise);
    worker.postMessage(request);
    return promise;
  }
}
export {
  WorkerPool
};
