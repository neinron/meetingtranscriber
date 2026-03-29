const crypto = require("node:crypto");

class TaskLane {
  constructor(name, concurrency = 1) {
    this.name = name;
    this.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1;
    this.activeCount = 0;
    this.queue = [];
  }

  enqueue(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.activeCount < this.concurrency && this.queue.length) {
      const nextTask = this.queue.shift();
      this.activeCount += 1;

      Promise.resolve()
        .then(nextTask.operation)
        .then(nextTask.resolve, nextTask.reject)
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.pump();
        });
    }
  }

  snapshot() {
    return {
      name: this.name,
      concurrency: this.concurrency,
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
    };
  }
}

class TaskCoordinator {
  constructor({ laneLimits = {}, onEvent } = {}) {
    this.laneLimits = { ...laneLimits };
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.lanes = new Map();
    this.lockTails = new Map();
    this.recordingCounts = new Map();
    this.activeTasks = new Map();
  }

  getLane(laneName = "default") {
    if (!this.lanes.has(laneName)) {
      const concurrency = this.laneLimits[laneName] ?? 1;
      this.lanes.set(laneName, new TaskLane(laneName, concurrency));
    }
    return this.lanes.get(laneName);
  }

  incrementRecording(recordingId) {
    if (!recordingId) {
      return;
    }
    this.recordingCounts.set(recordingId, (this.recordingCounts.get(recordingId) || 0) + 1);
  }

  decrementRecording(recordingId) {
    if (!recordingId) {
      return;
    }
    const nextCount = (this.recordingCounts.get(recordingId) || 0) - 1;
    if (nextCount > 0) {
      this.recordingCounts.set(recordingId, nextCount);
      return;
    }
    this.recordingCounts.delete(recordingId);
  }

  emit(event, taskSnapshot) {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event, {
        ...taskSnapshot,
        lanes: this.getSnapshot().lanes,
      });
    } catch {
      // Coordinator telemetry should never break task execution.
    }
  }

  schedule({
    name,
    lane = "default",
    lockKey = null,
    recordingId = null,
    task,
  }) {
    if (typeof task !== "function") {
      throw new Error("Task coordinator requires a task function.");
    }

    const operationId = crypto.randomUUID();
    const taskSnapshot = {
      operationId,
      name: name || "unnamed-task",
      lane,
      lockKey: lockKey || null,
      recordingId: recordingId || null,
      status: "queued",
      queuedAt: new Date().toISOString(),
    };

    this.activeTasks.set(operationId, taskSnapshot);
    this.incrementRecording(recordingId);
    this.emit("queued", taskSnapshot);

    const execute = async () => {
      const laneRunner = this.getLane(lane);
      return laneRunner.enqueue(async () => {
        taskSnapshot.status = "running";
        taskSnapshot.startedAt = new Date().toISOString();
        this.emit("started", taskSnapshot);

        try {
          const result = await task();
          taskSnapshot.status = "completed";
          taskSnapshot.completedAt = new Date().toISOString();
          this.emit("completed", taskSnapshot);
          return result;
        } catch (error) {
          taskSnapshot.status = "failed";
          taskSnapshot.completedAt = new Date().toISOString();
          taskSnapshot.error = error?.message || String(error);
          this.emit("failed", taskSnapshot);
          throw error;
        } finally {
          this.activeTasks.delete(operationId);
          this.decrementRecording(recordingId);
        }
      });
    };

    let scheduledPromise;
    if (lockKey) {
      const previousTail = this.lockTails.get(lockKey) || Promise.resolve();
      scheduledPromise = previousTail.catch(() => {}).then(execute);
      const nextTail = scheduledPromise.catch(() => {});
      this.lockTails.set(lockKey, nextTail);
      nextTail.finally(() => {
        if (this.lockTails.get(lockKey) === nextTail) {
          this.lockTails.delete(lockKey);
        }
      });
    } else {
      scheduledPromise = execute();
    }

    return scheduledPromise;
  }

  hasRecordingTask(recordingId) {
    return Boolean(recordingId && this.recordingCounts.has(recordingId));
  }

  getBusyRecordingIds() {
    return Array.from(this.recordingCounts.keys());
  }

  getSnapshot() {
    return {
      lanes: Array.from(this.lanes.values()).map((lane) => lane.snapshot()),
      activeTasks: Array.from(this.activeTasks.values()).map((task) => ({ ...task })),
      busyRecordingIds: this.getBusyRecordingIds(),
    };
  }
}

const createTaskCoordinator = (options) => new TaskCoordinator(options);

module.exports = {
  TaskCoordinator,
  createTaskCoordinator,
};
