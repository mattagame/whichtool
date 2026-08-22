export class WhichtoolError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'WhichtoolError'
    this.code = code
    this.hint = hint
  }
}

export class NotImplementedError extends WhichtoolError {
  constructor(message: string, hint?: string) {
    super('not-implemented', message, hint)
    this.name = 'NotImplementedError'
  }
}
