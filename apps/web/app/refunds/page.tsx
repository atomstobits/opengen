import { permanentRedirect } from 'next/navigation';

export default function RefundsRedirectPage() {
  permanentRedirect('/terms#credits-and-refunds');
}
