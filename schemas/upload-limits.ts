// Shared by browser preflight and the bounded streaming multipart parser.
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024
export const MAX_UPLOAD_FILES = 50
export const MAX_UPLOAD_AGGREGATE_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_AGGREGATE_BYTES + 1024 * 1024
