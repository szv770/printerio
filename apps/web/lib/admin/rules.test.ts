import { describe, it, expect } from "vitest";
import { actionVerb, buildConditions, quotaSentence, ruleSentence, unitWord } from "./rules";

describe("ruleSentence", () => {
  it("reads like a sentence", () => {
    expect(
      ruleSentence({
        action: "require_approval",
        conditions: [
          { field: "colorMode", operator: "eq", value: "color" },
          { field: "pageCount", operator: "gt", value: 20 },
        ],
      }),
    ).toBe("Color jobs over 20 pages need approval");
  });
  it("handles an empty rule", () => {
    expect(ruleSentence({ action: "deny", conditions: [] })).toBe("Every job is not allowed");
  });
  it("describes allow and block", () => {
    expect(ruleSentence({ action: "allow", conditions: [{ field: "role", operator: "eq", value: "approver" }] })).toBe(
      "Jobs from approvers are allowed",
    );
    expect(
      ruleSentence({
        action: "deny",
        conditions: [
          { field: "colorMode", operator: "eq", value: "color" },
          { field: "role", operator: "eq", value: "student" },
        ],
      }),
    ).toBe("Color jobs from users are not allowed");
  });
  it("covers copies, sheets, double-sided and finishing", () => {
    expect(ruleSentence({ action: "require_approval", conditions: [{ field: "copies", operator: "gt", value: 30 }] })).toBe(
      "Jobs with more than 30 copies need approval",
    );
    expect(
      ruleSentence({ action: "require_approval", conditions: [{ field: "estimatedPhysicalSheets", operator: "gte", value: 100 }] }),
    ).toBe("Jobs using 100 or more sheets need approval");
    expect(ruleSentence({ action: "deny", conditions: [{ field: "duplex", operator: "eq", value: false }] })).toBe(
      "Single-sided jobs are not allowed",
    );
    expect(ruleSentence({ action: "require_approval", conditions: [{ field: "finishingBooklet", operator: "eq", value: true }] })).toBe(
      "Booklet jobs need approval",
    );
  });
  it("covers paper size, time and weekdays", () => {
    expect(ruleSentence({ action: "require_approval", conditions: [{ field: "paperSize", operator: "eq", value: "11x17" }] })).toBe(
      "Jobs on 11x17 paper need approval",
    );
    expect(ruleSentence({ action: "deny", conditions: [{ field: "dayOfWeek", operator: "in", value: [0, 6] }] })).toBe(
      "Jobs on weekends are not allowed",
    );
    expect(ruleSentence({ action: "deny", conditions: [{ field: "timeOfDayMinutes", operator: "gte", value: 17 * 60 }] })).toBe(
      "Jobs from 5:00 PM on are not allowed",
    );
  });
  it("names groups when it is told how", () => {
    expect(
      ruleSentence(
        { action: "allow", conditions: [{ field: "groupIds", operator: "contains", value: "g1" }] },
        { groupName: (id) => (id === "g1" ? "Science" : null) },
      ),
    ).toBe("Jobs from the Science group are allowed");
    expect(ruleSentence({ action: "allow", conditions: [{ field: "groupIds", operator: "contains", value: "g9" }] })).toBe(
      "Jobs from a certain group are allowed",
    );
  });
  it("never leaks field names for conditions it does not know", () => {
    const s = ruleSentence({ action: "deny", conditions: [{ field: "mystery" as never, operator: "eq", value: 1 }] });
    expect(s).toBe("Jobs that match a custom condition are not allowed");
    expect(s).not.toMatch(/mystery|\beq\b|_/);
  });
});

describe("actionVerb", () => {
  it("has plain words", () => {
    expect(actionVerb("allow")).toBe("are allowed");
    expect(actionVerb("require_approval")).toBe("need approval");
    expect(actionVerb("deny")).toBe("are not allowed");
  });
});

describe("buildConditions", () => {
  it("builds nothing for an empty form", () => {
    expect(buildConditions({ color: "any", pagesOver: "", copiesOver: "", role: "any", stapled: false })).toEqual([]);
  });
  it("builds the conditions the policy engine reads", () => {
    expect(buildConditions({ color: "color", pagesOver: "20", copiesOver: "5", role: "student", stapled: true })).toEqual([
      { field: "colorMode", operator: "eq", value: "color" },
      { field: "pageCount", operator: "gt", value: 20 },
      { field: "copies", operator: "gt", value: 5 },
      { field: "role", operator: "eq", value: "student" },
      { field: "finishingStaple", operator: "eq", value: true },
    ]);
  });
  it("ignores numbers that are not positive whole numbers", () => {
    expect(buildConditions({ color: "bw", pagesOver: "-3", copiesOver: "abc", role: "any", stapled: false })).toEqual([
      { field: "colorMode", operator: "eq", value: "bw" },
    ]);
  });
});

describe("quotaSentence / unitWord", () => {
  it("uses plain words for the unit", () => {
    expect(unitWord("physical_sheets")).toBe("sheets");
    expect(unitWord("pdf_pages")).toBe("pages");
    expect(unitWord("printed_sides")).toBe("sides");
    expect(unitWord("color_weighted")).toBe("color-weighted pages");
    expect(unitWord(undefined)).toBe("sheets");
  });
  it("says who the limit is for", () => {
    expect(quotaSentence({ scope_type: "organization", scope_value: null }, {})).toBe("Everyone");
    expect(quotaSentence({ scope_type: "role", scope_value: "student" }, {})).toBe("Users");
    expect(quotaSentence({ scope_type: "role", scope_value: "staff" }, {})).toBe("Staff");
    expect(quotaSentence({ scope_type: "department", scope_value: "Science" }, {})).toBe("The Science department");
    expect(quotaSentence({ scope_type: "group", scope_value: "g1" }, { groupName: () => "Grade 7" })).toBe("The Grade 7 group");
    expect(quotaSentence({ scope_type: "user", scope_value: "u1" }, { userName: () => "Dana" })).toBe("Dana");
  });
});
