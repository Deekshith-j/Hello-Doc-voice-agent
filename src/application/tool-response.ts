// Standardizes tool results so both Retell and tests receive predictable, speakable output.
// Machine-readable codes support eval grading without forcing the agent to parse prose.
export interface ToolResponse<TData = unknown> {
  code: string;
  data?: TData;
  message: string;
  ok: boolean;
}

export function toolSuccess<TData>(
  code: string,
  message: string,
  data: TData,
): ToolResponse<TData> {
  return { ok: true, code, message, data };
}

export function toolFailure<TData = unknown>(
  code: string,
  message: string,
  data?: TData,
): ToolResponse<TData> {
  return data === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, data };
}
