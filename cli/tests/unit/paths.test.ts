import { describe, expect, it } from "vitest";
import {
  DECISION_LOG_PATH,
  IGNORE_MANIFEST_PATH,
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  LEGACY_DECISION_LOG_PATH,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";

describe("lib/paths", () => {
  it("DECISION_LOG_PATH points to the qualy-namespaced location under .harn", () => {
    expect(DECISION_LOG_PATH).toBe(".harn/qualy/docs/lint-decisions.md");
  });

  it("LEGACY_DECISION_LOG_PATH retains the pre-namespace location", () => {
    expect(LEGACY_DECISION_LOG_PATH).toBe("docs/lint-decisions.md");
  });

  it("IGNORE_MANIFEST_PATH lives under .harn/qualy", () => {
    expect(IGNORE_MANIFEST_PATH).toBe(".harn/qualy/ignore.json");
  });

  it("PRESET_PATHS exposes fast and deep relative paths", () => {
    expect(PRESET_PATHS.fast).toBe("oxlint.fast.json");
    expect(PRESET_PATHS.deep).toBe("oxlint.deep.json");
  });

  it("ignore markers carry the qualy namespace", () => {
    expect(IGNORE_MARKER_START).toBe("_qualy:start_");
    expect(IGNORE_MARKER_END).toBe("_qualy:end_");
  });

  it("PRESET_PATHS is readonly (frozen)", () => {
    expect(Object.isFrozen(PRESET_PATHS)).toBe(true);
  });
});
