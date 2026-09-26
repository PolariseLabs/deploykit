import { Effect, Schema } from "effect"
import {
  ProviderError,
  SourceError,
  IntegrityError,
  TransferLimitError,
  ValidationError,
  UploadError
} from "./errors.js"
import { UnsupportedError } from "./provider.js"

export const Failure = Schema.Union([
  ProviderError,
  SourceError,
  IntegrityError,
  TransferLimitError,
  ValidationError,
  UnsupportedError,
  UploadError
])
export type Failure = typeof Failure.Type
export const WireFailure = Schema.Struct({ version: Schema.Literal(1), error: Failure })
const JsonFailure = Schema.fromJsonString(WireFailure)
export const encodeFailure = (error: Failure) =>
  Schema.encodeEffect(JsonFailure)({ version: 1, error }).pipe(
    Effect.mapError(() => new ValidationError({ message: "Cannot encode failure" }))
  )
export const decodeFailure = (json: string) =>
  Schema.decodeUnknownEffect(JsonFailure)(json).pipe(
    Effect.map(value => value.error),
    Effect.mapError(() => new ValidationError({ message: "Invalid wire failure" }))
  )
