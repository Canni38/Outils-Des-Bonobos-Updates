export interface SessionRefreshOperation {
  generation: number;
  signal: AbortSignal;
}

interface ActiveRefresh {
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
}

export class SessionOperationCoordinator {
  private generation = 0;
  private activeRefresh: ActiveRefresh | null = null;
  private credentialOperationTail: Promise<void> = Promise.resolve();
  private sessionMutationTail: Promise<void> = Promise.resolve();

  invalidate(): number {
    this.generation += 1;
    this.activeRefresh?.controller.abort();
    this.activeRefresh = null;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  runIfCurrent(generation: number, operation: () => void): boolean {
    if (!this.isCurrent(generation)) {
      return false;
    }
    operation();
    return true;
  }

  runRefresh(operation: (context: SessionRefreshOperation) => Promise<void>): Promise<void> {
    if (this.activeRefresh?.generation === this.generation) {
      return this.activeRefresh.promise;
    }

    const generation = this.generation;
    const controller = new AbortController();
    const activeRefresh: ActiveRefresh = {
      generation,
      controller,
      promise: Promise.resolve(),
    };
    activeRefresh.promise = Promise.resolve()
      .then(() => {
        if (!this.isCurrent(generation) || controller.signal.aborted) {
          return;
        }
        return operation({ generation, signal: controller.signal });
      })
      .finally(() => {
        if (this.activeRefresh === activeRefresh) {
          this.activeRefresh = null;
        }
      });
    this.activeRefresh = activeRefresh;
    return activeRefresh.promise;
  }

  runSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionMutationTail.then(operation, operation);
    this.sessionMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  runCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.credentialOperationTail.then(operation, operation);
    this.credentialOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
