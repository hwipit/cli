export class HwipError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'HwipError';
    this.code = code;
    this.status = status;
  }
}

export class AuthenticationError extends HwipError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class QuotaExceededError extends HwipError {
  constructor(message = 'Quota exceeded') {
    super(message, 'QUOTA_EXCEEDED', 403);
    this.name = 'QuotaExceededError';
  }
}
