import { describe, expect, it } from "vitest";
import { riskyAppFolder } from "@/core/sending/app-folder";

/**
 * The app folder outside Pictures/OneDrive (M6-DESIGN §2.4, D37): the name found is the one the go-live card names.
 * The owner's PC today: C:\Users\polyg\Pictures\outreach with OneDrive signed in (C:\Users\polyg\OneDrive).
 */

const env = { USERPROFILE: "C:\\Users\\polyg", OneDrive: "C:\\Users\\polyg\\OneDrive" };

describe("riskyAppFolder", () => {
  it("names Windows' own folders under the user profile", () => {
    expect(riskyAppFolder("C:\\Users\\polyg\\Pictures\\outreach", env)).toBe("Pictures");
    expect(riskyAppFolder("C:\\Users\\polyg\\Documents\\apps\\outreach", env)).toBe("Documents");
    expect(riskyAppFolder("C:\\Users\\polyg\\Desktop\\outreach", env)).toBe("Desktop");
    // Case and slashes don't matter; the name keeps the path's own spelling.
    expect(riskyAppFolder("c:/users/POLYG/pictures/outreach/", env)).toBe("pictures");
  });

  it("names a OneDrive folder, whatever it is called, and sync folders", () => {
    expect(riskyAppFolder("C:\\Users\\polyg\\OneDrive\\outreach", env)).toBe("OneDrive");
    expect(riskyAppFolder("C:\\Users\\polyg\\OneDrive - Firma\\outreach", env)).toBe("OneDrive - Firma");
    expect(riskyAppFolder("C:\\Users\\polyg\\OneDrive - Firma\\outreach", { USERPROFILE: env.USERPROFILE })).toBe("OneDrive - Firma");
    expect(riskyAppFolder("D:\\Sync\\Work stuff\\outreach", { OneDrive: "D:\\Sync\\Work stuff" })).toBe("Work stuff");
    expect(riskyAppFolder("C:\\Users\\polyg\\Dropbox\\outreach", env)).toBe("Dropbox");
    expect(riskyAppFolder("D:\\Google Drive\\outreach", env)).toBe("Google Drive");
    // The outermost one is named: OneDrive's own Pictures folder is inside OneDrive.
    expect(riskyAppFolder("C:\\Users\\polyg\\OneDrive\\Pictures\\outreach", env)).toBe("OneDrive");
  });

  it("is null for a safe folder", () => {
    expect(riskyAppFolder("C:\\Outreach", env)).toBeNull();
    expect(riskyAppFolder("D:\\Apps\\outreach", env)).toBeNull();
    expect(riskyAppFolder("C:\\Users\\polyg\\outreach", env)).toBeNull();
    expect(riskyAppFolder("", env)).toBeNull();
    // A user profile that happens to be called "Desktop" isn't the Desktop folder.
    expect(riskyAppFolder("C:\\Users\\Desktop\\outreach", { USERPROFILE: "C:\\Users\\Desktop" })).toBeNull();
  });
});
