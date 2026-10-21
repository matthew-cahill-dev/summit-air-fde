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
    // Real Deepgram nova-3 transcripts from production calls: digits for the house number,
    // tens as digits plus an ordinal word for the street.
    ["37 12 80 second Street", "37-12 82nd St"],
    ["37 12 80 second street.", "37-12 82nd St"],
    ["37 12 82nd Street", "37-12 82nd St"],
    ["37 12 80 2nd Street", "37-12 82nd St"],
    ["21 45 30 first street", "21-45 31st St"],
    ["21-45 30 first street", "21-45 31st St"],
    ["108 20 70 first avenue", "108-20 71st Ave"],
    ["35 10 30 third avenue", "35-10 33rd Ave"],
    ["14 20 20 first street", "14-20 21st St"],
    ["100 40 fifth street", "100 45th St"],
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
    ["37 12 80 third Street", "37-12 82nd St"],
    ["37 12 80 Street", "37-12 82nd St"],
    ["37 14 80 second Street", "37-12 82nd St"],
  ])("%j does not match %j", (said, stored) => {
    expect(streetAddressMatches(said, stored)).toBe(false);
  });

  it("normalizes into house/street digits and street words", () => {
    expect(normalizeStreetAddress("thirty-seven twelve eighty-second street")).toEqual({ digits: "371282", words: [], type: "st" });
    expect(normalizeStreetAddress("600 W 110th St, Apt 4B")).toEqual({ digits: "600110", words: ["w"], type: "st" });
    expect(normalizeStreetAddress("37 12 80 second Street")).toEqual({ digits: "371282", words: [], type: "st" });
    expect(normalizeStreetAddress("80 second").digits).toBe("82");
    expect(normalizeStreetAddress("30 third").digits).toBe("33");
    expect(normalizeStreetAddress("20 first").digits).toBe("21");
    expect(normalizeStreetAddress("40 fifth").digits).toBe("45");
    expect(normalizeStreetAddress("37 12").digits).toBe(normalizeStreetAddress("37-12").digits);
  });
});
