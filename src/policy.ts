import * as World from 'mppx/extensions/identity/world';

// Selfie Check is the minimum accepted account level. Explicit essential claims
// must include stronger Orb classes too; they are distinct exact-match values.
export const acceptedAcr = [
  World.Constants.acr.selfie, World.Constants.acr.selfieFace,
  World.Constants.acr.orb, World.Constants.acr.orbFace,
] as const;

export function authenticationClasses(policy = 'selfie-or-orb'): readonly string[] {
  if (policy === 'selfie-or-orb') return acceptedAcr;
  if (policy === 'selfie') return [World.Constants.acr.selfie, World.Constants.acr.selfieFace];
  throw new Error('Unknown World ID account policy');
}
