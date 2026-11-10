import onboarding from './onboarding.playwright.config';
export default { ...onboarding, testMatch: 'feedback.spec.ts' };
