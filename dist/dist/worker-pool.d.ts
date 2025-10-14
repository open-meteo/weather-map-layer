export class WorkerPool {
    workers: Worker[];
    nextWorker: number;
    pendingTiles: Map<any, any>;
    resolvers: Map<any, any>;
    handleMessage(message: any): void;
    getNextWorker(): Worker | undefined;
    requestTile(request: any): any;
}
