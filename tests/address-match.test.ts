import { describe, expect, it } from "vitest";
import { normalizeStreetAddress, streetAddressMatches } from "@/server/lib/address-match";

describe("streetAddressMatches", () => {
  it.each([
    ["37-12 82nd Street", "37-12 82nd St"],
    ["thirty-seven twelve eighty-second street", "37-12 82nd St"],
    ["thirty seven twelve eighty second", "37-12 82nd St"],
    ["3712 82nd st.", "37-12 82nd St"],
    ["four twelve seventh avenue", "412 Seventh Ave"],
    ["412 7th Ave", "412 Seventh Ave"],
    ["one oh eight twenty seventy first avenue", "108-20 71st Ave"],
    ["one hundred eight twenty 71st ave", "108-20 71st Ave"],
    ["twenty one forty five thirty first street, apartment 1R", "21-45 31st St"],
    ["seventy five twenty ridge boulevard", "7520 Ridge Blvd"],
    ["fourteen fifty ocean avenue apt 5C", "1450 Ocean Ave"],
    ["two eleven prospect park west", "211 Prospect Park W"],
    ["164-20 Highland Avenue", "164-20 Highland Ave"],
    ["eighty eight rockrose", "88 Rockrose Ave"],
  ])("%j matches %j", (said, stored) => {
    expect(streetAddressMatches(said, stored)).toBe(true);
  });

  it.each([
    ["37-14 82nd Street", "37-12 82nd St"],
    ["37-12 83rd Street", "37-12 82nd St"],
    ["82nd Street", "37-12 82nd St"],
    ["412 Sixth Ave", "412 Seventh Ave"],
    ["211 Prospect Park East", "211 Prospect Park W"],
    ["1450 Ocean Parkway", "1450 Ocean Ave"],
    ["", "1450 Ocean Ave"],
  ])("%j does not match %j", (said, stored) => {
    expect(streetAddressMatches(said, stored)).toBe(false);
  });

  it("normalizes into house/street digits and street words", () => {
    expect(normalizeStreetAddress("thirty-seven twelve eighty-second street")).toEqual({ digits: "371282", words: [], type: "st" });
    expect(normalizeStreetAddress("600 W 110th St, Apt 4B")).toEqual({ digits: "600110", words: ["w"], type: "st" });
  });
});
