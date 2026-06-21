/** Typed CKAN error hierarchy. CKAN often returns 200 + {success:false}. */
export class CkanError extends Error {
  constructor(
    message: string,
    public readonly ckanType?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CkanError";
  }
}

export class CkanNotFoundError extends CkanError {
  constructor(message = "Resource not found", httpStatus?: number) {
    super(message, "Not Found Error", httpStatus);
    this.name = "CkanNotFoundError";
  }
}

export class CkanValidationError extends CkanError {
  constructor(message: string, httpStatus?: number) {
    super(message, "Validation Error", httpStatus);
    this.name = "CkanValidationError";
  }
}

export class CkanAuthError extends CkanError {
  constructor(message = "Authorization error", httpStatus?: number) {
    super(message, "Authorization Error", httpStatus);
    this.name = "CkanAuthError";
  }
}

export class CkanServerError extends CkanError {
  constructor(message = "CKAN server error", httpStatus?: number) {
    super(message, "Server Error", httpStatus);
    this.name = "CkanServerError";
  }
}

/** Map a CKAN error object / HTTP status into a typed error. */
export function toCkanError(
  errType: string | undefined,
  message: string,
  httpStatus?: number,
): CkanError {
  const t = (errType ?? "").toLowerCase();
  if (t.includes("not found") || httpStatus === 404) return new CkanNotFoundError(message, httpStatus);
  if (t.includes("authorization") || httpStatus === 403 || httpStatus === 401)
    return new CkanAuthError(message, httpStatus);
  if (t.includes("validation") || httpStatus === 409 || httpStatus === 400)
    return new CkanValidationError(message, httpStatus);
  if (httpStatus && httpStatus >= 500) return new CkanServerError(message, httpStatus);
  return new CkanError(message, errType, httpStatus);
}
