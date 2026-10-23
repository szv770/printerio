import { afterEach, describe, expect, it, vi } from "vitest";

// The preview page imports many client components; only its first lines matter here.
vi.mock("./member-pages", () => ({}));
vi.mock("./admin-a", () => ({}));
vi.mock("./admin-b", () => ({}));
vi.mock("./booklet", () => ({}));
vi.mock("./homes", () => ({}));
vi.mock("./sections", () => ({}));

import PreviewPage from "./page";

afterEach(() => vi.unstubAllEnvs());

describe("/dev/preview", () => {
  it.each(["production", "test"])("is a 404 when NODE_ENV is %s", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    await expect(PreviewPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
});
