export class AsyncQueue {
  private pending = Promise.resolve();
  private onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void = () => {}) {
    this.onError = onError;
  }

  push(task: () => Promise<void>) {
    this.pending = this.pending.then(task).catch((error) => {
      this.onError(error);
    });
    return this.pending;
  }
}
