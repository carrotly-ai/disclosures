import type { AdapterOptions } from "./types.js";

export const RESTRICTED_SOURCE_ACKNOWLEDGEMENTS = {
  ASX: "DISCLOSURES_ACKNOWLEDGE_ASX_TERMS",
  PSE: "DISCLOSURES_ACKNOWLEDGE_PSE_TERMS",
} as const;

export type RestrictedSource = keyof typeof RESTRICTED_SOURCE_ACKNOWLEDGEMENTS;

const RESTRICTED_SOURCE_DETAILS: Record<
  RestrictedSource,
  { label: string; restriction: string; termsUrl: string }
> = {
  ASX: {
    label: "ASX",
    restriction:
      "personal, non-commercial use and restrictions on automation and redistribution",
    termsUrl: "https://www.asx.com.au/legals/terms-of-use",
  },
  PSE: {
    label: "PSE EDGE",
    restriction:
      "personal, non-commercial use and restrictions on transmitting or redistributing content",
    termsUrl: "https://edge.pse.com.ph/page/disclaimer.do",
  },
};

export function hasRestrictedSourceAcknowledgement(
  source: RestrictedSource,
  options: AdapterOptions = {},
): boolean {
  const env = options.env ?? process.env;
  return env[RESTRICTED_SOURCE_ACKNOWLEDGEMENTS[source]]?.trim() === "1";
}

export function restrictedSourceDisabledMessage(source: RestrictedSource): string {
  const detail = RESTRICTED_SOURCE_DETAILS[source];
  const variable = RESTRICTED_SOURCE_ACKNOWLEDGEMENTS[source];
  return `${detail.label} access is disabled by default because its terms restrict ${detail.restriction}. No request was made. Review ${detail.termsUrl}, then set ${variable}=1 only if you have the rights to use this source in your context.`;
}
