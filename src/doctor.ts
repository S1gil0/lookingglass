export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

/**
 * Keep scheduler discovery independent from the other doctor checks. A
 * scheduler backend can fail because its native service manager is missing or
 * inaccessible, but that must still be reported as one check rather than
 * aborting the rest of the diagnostic.
 */
export function schedulerDoctorCheck(status: () => string): DoctorCheck {
  try {
    const value = status();
    return {
      name: "scheduler",
      ok: /ActiveState=active/.test(value),
      detail: value.replace(/\n/g, ", "),
      fatal: false,
    };
  } catch (error) {
    return {
      name: "scheduler",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fatal: true,
    };
  }
}