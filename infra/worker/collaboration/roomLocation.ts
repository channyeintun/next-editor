export type CollaborationRoomLocationHint =
  | "wnam"
  | "enam"
  | "sam"
  | "weur"
  | "eeur"
  | "apac"
  | "apac-ne"
  | "apac-se"
  | "oc"
  | "afr"
  | "me";

interface RequestLocation {
  continent?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

function coordinate(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Choose the first-placement hint for a room from its creator's edge location. */
export function collaborationRoomLocationHintFromCf(
  value: unknown,
): CollaborationRoomLocationHint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const location = value as RequestLocation;
  const continent = typeof location.continent === "string" ? location.continent : "";
  const latitude = coordinate(location.latitude);
  const longitude = coordinate(location.longitude);

  switch (continent) {
    case "AF":
      return "afr";
    case "EU":
      return longitude !== undefined && longitude >= 20 ? "eeur" : "weur";
    case "NA":
      return longitude !== undefined && longitude <= -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "OC":
      return "oc";
    case "AS":
      if (longitude !== undefined && longitude < 65) return "me";
      if (
        latitude !== undefined &&
        longitude !== undefined &&
        latitude >= 25 &&
        longitude >= 105
      ) {
        return "apac-ne";
      }
      if (latitude !== undefined && latitude < 25) return "apac-se";
      return "apac";
    default:
      return undefined;
  }
}

export function collaborationRoomLocationHint(
  request: Request,
): CollaborationRoomLocationHint | undefined {
  const cf = (request as Request & { readonly cf?: unknown }).cf;
  return collaborationRoomLocationHintFromCf(cf);
}
