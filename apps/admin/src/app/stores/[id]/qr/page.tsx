import { redirect } from 'next/navigation';

/** The QR page moved into the shared "QR codes & barcodes" page (BARCODE-1): thin redirect. */
export default async function QrRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/stores/${id}/codes?tab=qr`);
}
