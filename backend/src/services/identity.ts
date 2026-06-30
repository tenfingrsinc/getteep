import { query } from "../db/database";

export type AddressDisplayIdentity = {
  address: string;
  truncatedAddress: string;
  displayName: string;
  teepUsername: string | null;
  socialXHandle: string | null;
  creatorUsername: string | null;
  creatorDisplayName: string | null;
  profileImageUrl: string | null;
  publicAddress: string | null;
};

type SettingsIdentityRow = {
  address: string;
  username: string | null;
  social_x_handle: string | null;
  privacy_hide_address: boolean | null;
};

type ClaimIdentityRow = {
  owner_address: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
};

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function fallbackDisplayName() {
  return "Teep supporter";
}

function normalizeHandle(handle: string | null | undefined) {
  if (!handle) return null;
  const normalized = handle.replace(/^@/, "").trim().toLowerCase();
  return normalized || null;
}

function placeholders(values: string[]) {
  return values.map(() => "?").join(",");
}

export async function resolveAddressIdentities(addresses: string[]) {
  const normalizedAddresses = Array.from(
    new Set(addresses.map((address) => address.toLowerCase()).filter(Boolean))
  );
  const identities = new Map<string, AddressDisplayIdentity>();

  for (const address of normalizedAddresses) {
      identities.set(address, {
      address,
      truncatedAddress: truncateAddress(address),
      displayName: fallbackDisplayName(),
      teepUsername: null,
      socialXHandle: null,
      creatorUsername: null,
      creatorDisplayName: null,
      profileImageUrl: null,
      publicAddress: null,
    });
  }

  if (normalizedAddresses.length === 0) return identities;

  const sqlPlaceholders = placeholders(normalizedAddresses);
  const settings = await query<SettingsIdentityRow>(
    `SELECT address, username, social_x_handle, privacy_hide_address
     FROM user_settings
     WHERE LOWER(address) IN (${sqlPlaceholders})`,
    normalizedAddresses
  );
  const claims = await query<ClaimIdentityRow>(
    `SELECT owner_address, username, display_name, profile_image_url
     FROM verified_claims
     WHERE LOWER(owner_address) IN (${sqlPlaceholders})
     ORDER BY verified_at DESC`,
    normalizedAddresses
  );

  const claimByAddress = new Map<string, ClaimIdentityRow>();
  for (const claim of claims) {
    const key = claim.owner_address.toLowerCase();
    if (!claimByAddress.has(key)) claimByAddress.set(key, claim);
  }

  for (const setting of settings) {
    const address = setting.address.toLowerCase();
    const current = identities.get(address);
    if (!current) continue;
    const teepUsername = normalizeHandle(setting.username);
    const socialXHandle = normalizeHandle(setting.social_x_handle);
    identities.set(address, {
      ...current,
      teepUsername,
      socialXHandle,
      displayName: socialXHandle ? `@${socialXHandle}` : teepUsername ? `@${teepUsername}` : current.displayName,
      publicAddress: setting.privacy_hide_address === false ? address : null,
    });
  }

  for (const [address, claim] of claimByAddress) {
    const current = identities.get(address);
    if (!current) continue;
    const creatorUsername = normalizeHandle(claim.username);
    const creatorDisplayName = claim.display_name?.trim() || null;
    identities.set(address, {
      ...current,
      creatorUsername,
      creatorDisplayName,
      profileImageUrl: claim.profile_image_url || current.profileImageUrl,
      displayName:
        current.socialXHandle || current.teepUsername
          ? current.displayName
          : creatorDisplayName || (creatorUsername ? `@${creatorUsername}` : current.displayName),
    });
  }

  return identities;
}

export async function resolveAddressIdentity(address: string) {
  return (await resolveAddressIdentities([address])).get(address.toLowerCase()) ?? {
    address: address.toLowerCase(),
    truncatedAddress: truncateAddress(address.toLowerCase()),
    displayName: fallbackDisplayName(),
    teepUsername: null,
    socialXHandle: null,
    creatorUsername: null,
    creatorDisplayName: null,
    profileImageUrl: null,
    publicAddress: null,
  };
}
