import { describe, expect, it } from "vitest";
import { normalizeSourceLink } from "./link";

const ok = (input: string) => {
  const r = normalizeSourceLink(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.message}`);
  return r;
};

describe("Google Drive links all become one direct-download address", () => {
  const ID = "1Q6o-wEkpAsvRQIaJqSqcCOkBZhQAAdYI";
  const want = `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`;
  it.each([
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`,
    `https://drive.google.com/file/d/${ID}/edit`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?id=${ID}&export=download`,
    `https://drive.google.com/uc?export=download&id=${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    `  https://drive.google.com/file/d/${ID}/view  `,
    `drive.google.com/file/d/${ID}/view`,
  ])("%s", (input) => {
    const r = ok(input);
    expect(r.url.toString()).toBe(want);
    expect(r.kind).toBe("drive");
  });

  it("works when the link is inside a pasted message", () => {
    expect(ok(`Here it is: https://drive.google.com/file/d/${ID}/view?usp=sharing thanks!`).url.toString()).toBe(want);
  });

  it("keeps a resource key (older shared files need it)", () => {
    const r = ok(`https://drive.google.com/file/d/${ID}/view?usp=drive_link&resourcekey=0-Z87Erti6MoyLG97S_Fmt5A`);
    expect(r.url.searchParams.get("resourcekey")).toBe("0-Z87Erti6MoyLG97S_Fmt5A");
  });

  it("refuses a Drive FOLDER with a message that says what to do", () => {
    const r = normalizeSourceLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/folder/i);
  });

  it("explains Google's temporary viewer address instead of fetching it", () => {
    const r = normalizeSourceLink("https://doc-0g-0s-apps-viewer.googleusercontent.com/viewer/secure/pdf/abc/def/1792990500000/drive/066/ACF?authuser=0&print=true");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/temporary viewer address.*Anyone with the link/i);
  });
});

describe("Google Docs and Slides export as PDF", () => {
  it("document link becomes a PDF export", () => {
    const r = ok("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/edit?resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(r.kind).toBe("docs");
    expect(r.url.toString()).toBe("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/export?format=pdf&resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
  });
  it("keeps the resource key on the export (legacy shared documents need it)", () => {
    const doc = ok("https://docs.google.com/document/d/0B_WSU737WJ1fMmZHRGdZdlpyMm8/edit?resourcekey=0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(doc.url.searchParams.get("resourcekey")).toBe("0-_9-vGCV4kE0OgeUqM4qVZg");
    expect(doc.url.searchParams.get("format")).toBe("pdf");
    const slides = ok("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/edit?resourcekey=0-abc_DEF");
    expect(slides.url.searchParams.get("resourcekey")).toBe("0-abc_DEF");
  });
  it("presentation link becomes a PDF export", () => {
    const r = ok("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/edit#slide=id.p");
    expect(r.url.toString()).toBe("https://docs.google.com/presentation/d/1abcDEF_ghi-JKL/export/pdf");
  });
});

describe("Dropbox share links become the direct download", () => {
  it.each([
    ["https://www.dropbox.com/s/abc123xyz/Likkutei%20Sichos.pdf?dl=0", "https://www.dropbox.com/s/abc123xyz/Likkutei%20Sichos.pdf?dl=1"],
    ["https://dropbox.com/s/abc123xyz/a.pdf", "https://www.dropbox.com/s/abc123xyz/a.pdf?dl=1"],
    ["https://www.dropbox.com/s/abc123xyz/a.pdf?dl=0&raw=1&st=zzz", "https://www.dropbox.com/s/abc123xyz/a.pdf?dl=1"],
    ["https://www.dropbox.com/scl/fi/h2k3j4/Sicha.pdf?rlkey=Qw3rTy&st=ab12&dl=0", "https://www.dropbox.com/scl/fi/h2k3j4/Sicha.pdf?rlkey=Qw3rTy&dl=1"],
    ["https://www.dropbox.com/scl/fi/h2k3j4/flyer.png?rlkey=Qw3rTy&e=1&dl=0", "https://www.dropbox.com/scl/fi/h2k3j4/flyer.png?rlkey=Qw3rTy&dl=1"],
  ])("%s", (input, want) => {
    const r = ok(input);
    expect(r.kind).toBe("dropbox");
    expect(r.url.toString()).toBe(want);
  });
  it("is found inside a pasted message", () => {
    expect(ok("see https://www.dropbox.com/s/abc123xyz/a.pdf?dl=0 please").kind).toBe("dropbox");
  });
  it.each([
    ["https://www.dropbox.com/sh/abc123/AAAxyz?dl=0", /folder/i],
    ["https://www.dropbox.com/scl/fo/abc123/AAA?rlkey=k&dl=0", /folder/i],
    ["https://www.dropbox.com/home/Documents", /not a shared file/i],
    ["https://www.dropbox.com/s/abc123xyz", /not a shared file/i],
    ["https://www.dropbox.com/scl/fi/h2k3j4", /not a shared file/i],
    ["https://www.dropbox.com/s/abc123xyz/a.pdf/extra", /not a shared file/i],
  ])("refuses %s", (input, why) => {
    const r = normalizeSourceLink(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(why);
  });
  it("does not treat lookalike hosts as Dropbox", () => {
    expect(ok("https://dropbox.com.evil.example/s/abc123xyz/a.pdf").kind).toBe("direct");
    expect(ok("https://notdropbox.com/s/abc123xyz/a.pdf").kind).toBe("direct");
  });
});

describe("OneDrive share links", () => {
  const share = (url: string) => `https://api.onedrive.com/v1.0/shares/u!${Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}/root/content`;
  it("a 1drv.ms short link goes through the public shares address", () => {
    const r = ok("https://1drv.ms/b/s!AbCdEfGh_ij-KlMn");
    expect(r.kind).toBe("onedrive");
    expect(r.url.toString()).toBe(share("https://1drv.ms/b/s!AbCdEfGh_ij-KlMn"));
  });
  it("accepts a photo short link and the newer /c/<id>/ form", () => {
    expect(ok("https://1drv.ms/i/s!AbCdEfGh").kind).toBe("onedrive");
    expect(ok("https://1drv.ms/b/c/0123abcd4567ef89/EQAbCdEf").kind).toBe("onedrive");
  });
  it("an onedrive.live.com share link with resid and authkey works, other parameters are dropped", () => {
    const r = ok("https://onedrive.live.com/redir?resid=ABC123%21456&authkey=%21AbC&ithint=file%2cpdf&e=zzz");
    expect(r.kind).toBe("onedrive");
    expect(r.url.toString()).toBe(share("https://onedrive.live.com/redir?resid=ABC123%21456&authkey=%21AbC"));
  });
  it("a ?redeem= link is unpacked, but only when it holds a OneDrive address", () => {
    const inner = "https://1drv.ms/b/s!AbCdEfGh";
    const redeem = Buffer.from(inner).toString("base64").replace(/=+$/, "");
    expect(ok(`https://onedrive.live.com/?redeem=${redeem}`).url.toString()).toBe(share(inner));
    const evil = Buffer.from("https://evil.example/x").toString("base64");
    const r = normalizeSourceLink(`https://onedrive.live.com/?redeem=${evil}`);
    expect(r.ok).toBe(false);
    const internal = Buffer.from("https://169.254.169.254/").toString("base64");
    expect(normalizeSourceLink(`https://onedrive.live.com/?redeem=${internal}`).ok).toBe(false);
  });
  it.each([
    ["https://1drv.ms/f/s!AbCdEfGh", /folder/i],
    ["https://onedrive.live.com/redir?resid=A%21B&authkey=%21k&ithint=folder", /folder/i],
    ["https://1drv.ms/w/s!AbCdEfGh", /PDF or a JPEG\/PNG/i],
    ["https://1drv.ms/x/s!AbCdEfGh", /PDF or a JPEG\/PNG/i],
    ["https://onedrive.live.com/redir?resid=A%21B&authkey=%21k&ithint=file%2cdocx", /PDF or a JPEG\/PNG/i],
    ["https://onedrive.live.com/?id=ABC%21123&cid=ABC", /sign-in/i],
    ["https://onedrive.live.com/redir?resid=A%21B", /sign-in/i],
    ["https://onedrive.live.com/about/en-us/", /sign-in/i],
    ["https://1drv.ms/", /sign-in/i],
    ["https://contoso-my.sharepoint.com/:b:/g/personal/anna_contoso_com/EaBc?e=xyz", /work or school/i],
    ["https://contoso.sharepoint.com/sites/team/Shared%20Documents/a.pdf", /work or school/i],
  ])("refuses %s", (input, why) => {
    const r = normalizeSourceLink(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(why);
  });
  it("tells a folder from a sign-in problem", () => {
    const folder = normalizeSourceLink("https://1drv.ms/f/s!AbCdEfGh");
    const signin = normalizeSourceLink("https://contoso-my.sharepoint.com/:b:/g/x");
    expect([!folder.ok && folder.problem, !signin.ok && signin.problem]).toEqual(["folder", "needs_signin"]);
  });
  it("does not treat lookalike hosts as OneDrive", () => {
    expect(ok("https://1drv.ms.evil.example/b/s!AbCd").kind).toBe("direct");
    expect(ok("https://evil-onedrive.live.com.example/redir?resid=a&authkey=b").kind).toBe("direct");
  });
});

describe("links straight to a JPEG or PNG photo", () => {
  it.each(["https://example.org/flyer.jpg", "https://example.org/a/Flyer.JPEG", "https://cdn.example.org/pic.png?width=2000", "example.org/x.PNG"])("%s", (input) => {
    expect(ok(input).kind).toBe("image");
  });
  it("keeps the address as it is", () => {
    expect(ok("https://cdn.example.org/pic.png?width=2000").url.toString()).toBe("https://cdn.example.org/pic.png?width=2000");
  });
  it("other image types and web pages are not treated as photos", () => {
    expect(ok("https://example.org/a.gif").kind).toBe("direct");
    expect(ok("https://example.org/a.png.html").kind).toBe("direct");
    expect(ok("https://example.org/gallery").kind).toBe("direct");
  });
  it("a photo link still has to pass the address checks", () => {
    expect(normalizeSourceLink("https://127.0.0.1/a.jpg").ok).toBe(false);
    expect(normalizeSourceLink("http://example.org/a.jpg").ok).toBe(false);
  });
});

describe("any other https link is used as it is", () => {
  it("keeps the address and calls it direct", () => {
    const r = ok("https://www.hebrewbooks.org/pdfpager.aspx?req=14391&pgnum=5");
    expect(r.kind).toBe("direct");
    expect(r.url.toString()).toBe("https://www.hebrewbooks.org/pdfpager.aspx?req=14391&pgnum=5");
  });
  it("remembers the link as it was pasted", () => {
    expect(ok("https://www.dropbox.com/s/abc123xyz/a.pdf?dl=0").original.toString()).toBe("https://www.dropbox.com/s/abc123xyz/a.pdf?dl=0");
  });
  it("adds https when it is missing", () => {
    expect(ok("example.org/files/booklet.pdf").url.toString()).toBe("https://example.org/files/booklet.pdf");
  });
});

describe("refused, with a plain reason", () => {
  const bad: Array<[string, RegExp]> = [
    ["", /paste a link/i],
    ["hello there", /link/i],
    ["http://example.org/a.pdf", /https/i],
    ["ftp://example.org/a.pdf", /https/i],
    ["javascript:alert(1)", /link|https/i],
    ["file:///C:/secret.pdf", /https/i],
    ["https://user:pass@example.org/a.pdf", /sign-in|password|login/i],
    ["https://example.org:8443/a.pdf", /port|address/i],
    ["https://127.0.0.1/a.pdf", /address/i],
    ["https://localhost/a.pdf", /address/i],
    ["https://printer.local/a.pdf", /address/i],
    ["https://[::1]/a.pdf", /address/i],
    ["https://169.254.169.254/latest/meta-data", /address/i],
  ];
  it.each(bad)("%s", (input, why) => {
    const r = normalizeSourceLink(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(why);
  });
  it("refuses very long input", () => {
    expect(normalizeSourceLink(`https://example.org/${"a".repeat(5000)}`).ok).toBe(false);
  });
});
