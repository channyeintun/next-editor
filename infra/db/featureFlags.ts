/**
 * Stable D1 feature keys. Missing rows and any value other than integer 1 are
 * disabled, so new users never inherit private capabilities accidentally.
 */
export const STUDIO_BURMESE_VOXCPM2_FEATURE = "studio.burmese-voxcpm2" as const;

export type UserFeatureKey = typeof STUDIO_BURMESE_VOXCPM2_FEATURE;

export async function isUserFeatureEnabled(
  db: D1Database,
  userId: string,
  featureKey: UserFeatureKey,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT enabled
       FROM user_feature_flags
       WHERE user_id = ? AND feature_key = ?`,
    )
    .bind(userId, featureKey)
    .first<{ enabled: number }>();

  return row?.enabled === 1;
}
