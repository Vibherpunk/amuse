import { describe, expect, it } from "vitest";
import { hostsIn, userNamedHosts } from "../src/agent/sentinel";
import { decrypt, encrypt } from "../src/lib/vault";
import { parseIcs } from "../src/agent/tools/connectors";

describe("hostname extraction", () => {
  it("finds hostnames in ordinary text", () => {
    expect(hostsIn("Open https://Books.ToScrape.com/page and docs.example.org.")).toEqual(["books.toscrape.com", "docs.example.org"]);
    expect(userNamedHosts(["go to example.com", "nothing here"]).has("example.com")).toBe(true);
  });

  it("stays fast on adversarial input", () => {
    const t0 = Date.now();
    hostsIn("a.".repeat(50_000) + "!");
    hostsIn("a-".repeat(50_000) + ".");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("vault encryption", () => {
  it("round-trips and rejects a truncated auth tag", () => {
    const blob = encrypt("secret-value");
    expect(decrypt(blob)).toBe("secret-value");
    const [iv, tag, enc] = blob.split(".");
    const short = Buffer.from(tag!, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt([iv, short, enc].join("."))).toThrow();
  });
});

describe("calendar parsing", () => {
  it("still reads events", () => {
    const soon = new Date(Date.now() + 3600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${soon}\nSUMMARY:Lunch\\, with Sam\nLOCATION:Cafe\nEND:VEVENT\nEND:VCALENDAR`;
    expect(parseIcs(ics, 2)).toMatchObject([{ title: "Lunch, with Sam", location: "Cafe" }]);
  });
});
