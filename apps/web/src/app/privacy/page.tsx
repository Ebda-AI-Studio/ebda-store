import { Header, Footer } from '../../components';

export default function PrivacyPage() {
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
          <p className="mt-2 text-gray-500">
            Last updated:{' '}
            {new Date().toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        </div>

        <div className="mt-12 rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          <div className="prose prose-gray max-w-none">
            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">1. Information We Collect</h2>
              <p className="mt-2 text-gray-600">
                We collect information you provide directly to us, including:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Name, email address, and contact information</li>
                <li>Billing and shipping addresses</li>
                <li>Payment information (processed securely via Stripe)</li>
                <li>Order history and preferences</li>
                <li>Communications with our support team</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">
                2. How We Use Your Information
              </h2>
              <p className="mt-2 text-gray-600">We use the information we collect to:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Process and fulfill your orders</li>
                <li>Send order confirmations and shipping updates</li>
                <li>Respond to your questions and requests</li>
                <li>Improve our products and services</li>
                <li>Send promotional communications (with your consent)</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">3. Information Sharing</h2>
              <p className="mt-2 text-gray-600">
                We do not sell your personal information. We may share your information with:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>
                  Service providers who assist in our operations (payment processing, shipping)
                </li>
                <li>Law enforcement when required by law</li>
                <li>Business partners with your explicit consent</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">4. Data Security</h2>
              <p className="mt-2 text-gray-600">
                We implement appropriate security measures to protect your personal information,
                including:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>SSL encryption for all data transmission</li>
                <li>Secure payment processing through Stripe</li>
                <li>Regular security audits and updates</li>
                <li>Limited access to personal information by employees</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">5. Cookies</h2>
              <p className="mt-2 text-gray-600">We use cookies and similar technologies to:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Keep you logged in to your account</li>
                <li>Remember your cart contents</li>
                <li>Analyze site traffic and usage</li>
                <li>Personalize your shopping experience</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">6. Your Rights</h2>
              <p className="mt-2 text-gray-600">You have the right to:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Access your personal information</li>
                <li>Correct inaccurate information</li>
                <li>Request deletion of your data</li>
                <li>Opt out of marketing communications</li>
                <li>Export your data in a portable format</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">7. Contact Us</h2>
              <p className="mt-2 text-gray-600">
                If you have any questions about this Privacy Policy, please contact us at:
              </p>
              <p className="mt-2 text-gray-600">
                Email: privacy@forcemedia.com
                <br />
                Address: Kuwait City, Kuwait
              </p>
            </section>
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
