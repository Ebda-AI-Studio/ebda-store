import { Header, Footer } from '../../components';

export default function TermsPage() {
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Terms of Service</h1>
          <p className="mt-2 text-gray-500">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        <div className="mt-12 rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          <div className="prose prose-gray max-w-none">
            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">1. Acceptance of Terms</h2>
              <p className="mt-2 text-gray-600">
                By accessing and using Force Store, you agree to be bound by these Terms of Service.
                If you do not agree to these terms, please do not use our services.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">2. Use of Service</h2>
              <p className="mt-2 text-gray-600">
                You agree to use our service only for lawful purposes and in accordance with these Terms. You agree not to:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Violate any applicable laws or regulations</li>
                <li>Infringe on the rights of others</li>
                <li>Attempt to gain unauthorized access to our systems</li>
                <li>Use the service for fraudulent purposes</li>
                <li>Interfere with the proper functioning of the service</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">3. Account Registration</h2>
              <p className="mt-2 text-gray-600">
                When you create an account, you agree to:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Provide accurate and complete information</li>
                <li>Maintain the security of your account credentials</li>
                <li>Notify us immediately of any unauthorized access</li>
                <li>Be responsible for all activities under your account</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">4. Products and Pricing</h2>
              <p className="mt-2 text-gray-600">
                We strive to provide accurate product information and pricing, but errors may occur. We reserve the right to:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Correct pricing errors and update information</li>
                <li>Limit quantities available for purchase</li>
                <li>Cancel orders affected by errors</li>
                <li>Modify or discontinue products without notice</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">5. Payment Terms</h2>
              <p className="mt-2 text-gray-600">
                By placing an order, you agree that:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>You are authorized to use the payment method provided</li>
                <li>Payment information is accurate and complete</li>
                <li>You will pay all charges at the prices in effect when incurred</li>
                <li>All payments are processed securely through Stripe</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">6. Shipping and Delivery</h2>
              <p className="mt-2 text-gray-600">
                Shipping times are estimates and not guaranteed. We are not responsible for delays caused by:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
                <li>Shipping carrier delays</li>
                <li>Customs processing for international orders</li>
                <li>Incorrect shipping information provided</li>
                <li>Weather or other unforeseen circumstances</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">7. Returns and Refunds</h2>
              <p className="mt-2 text-gray-600">
                Our return policy allows returns within 30 days of delivery. Please refer to our
                Returns page for complete details on eligibility and process.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">8. Intellectual Property</h2>
              <p className="mt-2 text-gray-600">
                All content on this site, including text, graphics, logos, and software, is the property
                of Force Media and is protected by intellectual property laws. You may not reproduce,
                distribute, or create derivative works without our written consent.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">9. Limitation of Liability</h2>
              <p className="mt-2 text-gray-600">
                To the maximum extent permitted by law, Force Media shall not be liable for any indirect,
                incidental, special, or consequential damages arising from your use of our services.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">10. Changes to Terms</h2>
              <p className="mt-2 text-gray-600">
                We reserve the right to modify these terms at any time. Continued use of the service
                after changes constitutes acceptance of the new terms.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900">11. Contact Information</h2>
              <p className="mt-2 text-gray-600">
                For questions about these Terms of Service, please contact us at:
              </p>
              <p className="mt-2 text-gray-600">
                Email: legal@forcemedia.com<br />
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
