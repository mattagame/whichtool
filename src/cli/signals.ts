export interface InterruptHost {
  // Process and EventEmitter both expose these operations, but Node's Process type narrows
  // them with platform-specific overloads. Keep only the callability needed here.
  once: (...args: any[]) => unknown
  removeListener: (...args: any[]) => unknown
}

export interface InterruptResult<T> {
  result: T
  interrupted: boolean
}

/**
 * Give one CLI invocation an AbortSignal. The listener is registered with `once`: after the
 * first Ctrl+C requests a graceful stop, a second Ctrl+C has the host's normal immediate
 * termination behaviour again.
 */
export async function withInterruptSignal<T>(
  host: InterruptHost,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<InterruptResult<T>> {
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  host.once('SIGINT', interrupt)

  try {
    const result = await work(controller.signal)
    return { result, interrupted: controller.signal.aborted }
  } finally {
    host.removeListener('SIGINT', interrupt)
  }
}
