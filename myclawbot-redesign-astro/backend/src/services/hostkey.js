export async function createHostkeyServer({ userId, plan, region, image = 'ubuntu-22.04' }) {
  if (!process.env.HOSTKEY_API_KEY) {
    throw new Error('HOSTKEY_API_KEY is not configured');
  }

  // TODO: replace with real Hostkey endpoint from account docs.
  // For now returns synthetic payload so backend flow can be built end-to-end.
  return {
    externalServerId: `hk_${Date.now()}`,
    status: 'provisioning',
    ip: null,
    metadata: { userId, plan, region, image },
  };
}
