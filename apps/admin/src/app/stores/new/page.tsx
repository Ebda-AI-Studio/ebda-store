'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Button, Input, Badge } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';

interface CreatedStore {
  id: string;
  name: string;
  slug: string;
  domain?: string;
}

interface CreatedOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  temporaryPassword?: string;
}

type Step = 'store' | 'owner' | 'plan' | 'review';

const steps: { id: Step; name: string; description: string }[] = [
  { id: 'store', name: 'Store Details', description: 'Basic store information' },
  { id: 'owner', name: 'Store Owner', description: 'Owner account setup' },
  { id: 'plan', name: 'Select Plan', description: 'Choose a subscription plan' },
  { id: 'review', name: 'Review & Create', description: 'Confirm and create store' },
];

const plans = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    description: 'Perfect for testing',
    features: ['Up to 10 products', 'Basic analytics', 'Email support'],
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 29,
    description: 'For small businesses',
    features: ['Up to 100 products', 'Advanced analytics', 'Priority support', 'Custom domain'],
    popular: true,
  },
  {
    id: 'professional',
    name: 'Professional',
    price: 79,
    description: 'For growing businesses',
    features: [
      'Unlimited products',
      'Full analytics suite',
      '24/7 support',
      'Custom domain',
      'API access',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: -1,
    description: 'For large organizations',
    features: [
      'Everything in Professional',
      'Dedicated support',
      'Custom integrations',
      'SLA guarantee',
    ],
  },
];

export default function CreateStorePage() {
  const [currentStep, setCurrentStep] = useState<Step>('store');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ store: CreatedStore; owner: CreatedOwner } | null>(null);

  const [formData, setFormData] = useState({
    storeName: '',
    storeSlug: '',
    customDomain: '',
    ownerEmail: '',
    ownerName: '',
    ownerPassword: '',
    plan: 'starter',
  });

  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  function generateSlug(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function handleNameChange(value: string) {
    setFormData(prev => ({
      ...prev,
      storeName: value,
      storeSlug: generateSlug(value),
    }));
    setValidationErrors(prev => ({ ...prev, storeName: '', storeSlug: '' }));
  }

  function validateStep(step: Step): boolean {
    const errors: Record<string, string> = {};

    if (step === 'store') {
      if (!formData.storeName.trim()) errors.storeName = 'Store name is required';
      if (!formData.storeSlug.trim()) errors.storeSlug = 'Store URL is required';
      if (formData.storeSlug && !/^[a-z0-9-]+$/.test(formData.storeSlug)) {
        errors.storeSlug = 'URL can only contain lowercase letters, numbers, and hyphens';
      }
    }

    if (step === 'owner') {
      if (!formData.ownerEmail.trim()) errors.ownerEmail = 'Email is required';
      if (formData.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.ownerEmail)) {
        errors.ownerEmail = 'Please enter a valid email address';
      }
      if (!formData.ownerName.trim()) errors.ownerName = 'Owner name is required';
      if (!formData.ownerPassword) errors.ownerPassword = 'Password is required';
      if (formData.ownerPassword && formData.ownerPassword.length < 8) {
        errors.ownerPassword = 'Password must be at least 8 characters';
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function nextStep() {
    if (!validateStep(currentStep)) return;

    const stepIndex = steps.findIndex(s => s.id === currentStep);
    if (stepIndex < steps.length - 1) {
      setCurrentStep(steps[stepIndex + 1].id);
    }
  }

  function prevStep() {
    const stepIndex = steps.findIndex(s => s.id === currentStep);
    if (stepIndex > 0) {
      setCurrentStep(steps[stepIndex - 1].id);
    }
  }

  async function handleSubmit() {
    if (!validateStep('owner')) {
      setCurrentStep('owner');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const token = localStorage.getItem('authToken');
      const payload = {
        storeName: formData.storeName,
        storeSlug: formData.storeSlug,
        ownerEmail: formData.ownerEmail,
        ownerName: formData.ownerName,
        ownerPassword: formData.ownerPassword,
        plan: formData.plan,
        domain: formData.customDomain || undefined,
      };
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || data.message || 'Failed to create store');
      }

      setSuccess({
        store: data.data.store,
        owner: data.data.owner,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  }

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  // Domain verification polling
  const [domainStatus, setDomainStatus] = useState<{
    verified: boolean;
    dnsRecords: Array<{ type: string; name: string; value: string }>;
  } | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);

  const checkDomainStatus = useCallback(async (storeId: string) => {
    setIsCheckingDns(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${storeId}/domain`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.ok) {
        const data = await response.json();
        setDomainStatus(data.data);
      }
    } catch {
      // Silently fail — DNS check is non-critical
    } finally {
      setIsCheckingDns(false);
    }
  }, []);

  // Auto-check DNS on success if domain was provided
  useEffect(() => {
    if (success?.store.domain) {
      checkDomainStatus(success.store.id);
    }
  }, [success, checkDomainStatus]);

  // Success Screen
  if (success) {
    return (
      <AdminLayout title="Store Created!" subtitle="Your new store is ready">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-xl border bg-white p-8 shadow-sm text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <svg
                className="h-8 w-8 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="mt-4 text-2xl font-bold text-gray-900">Store Created Successfully!</h2>
            <p className="mt-2 text-gray-500">
              {success.store.name} is now live and ready for products.
            </p>

            <div className="mt-6 rounded-lg bg-gray-50 p-4 text-left">
              <h3 className="font-semibold text-gray-900">Store Details</h3>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Store URL:</dt>
                  <dd className="font-medium">
                    {success.store.domain || `${success.store.slug}.forcemediakw.com`}
                  </dd>
                </div>
                {success.store.domain && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Default URL:</dt>
                    <dd className="font-medium text-gray-400">
                      {success.store.slug}.forcemediakw.com
                    </dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-gray-500">Owner Email:</dt>
                  <dd className="font-medium">{success.owner.email}</dd>
                </div>
                {success.owner.temporaryPassword && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Temporary Password:</dt>
                    <dd className="font-mono font-medium text-primary">
                      {success.owner.temporaryPassword}
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            {/* DNS Instructions (shown when custom domain was provided) */}
            {success.store.domain && (
              <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-left">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-amber-900">DNS Configuration Required</h3>
                  <Badge variant={domainStatus?.verified ? 'default' : 'secondary'}>
                    {domainStatus?.verified ? 'Verified' : 'Pending'}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-amber-800">
                  Add the following DNS record to your domain provider to complete setup:
                </p>
                <div className="mt-3 overflow-hidden rounded-md border border-amber-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-amber-50">
                        <th className="px-3 py-2 text-left font-medium text-amber-900">Type</th>
                        <th className="px-3 py-2 text-left font-medium text-amber-900">Name</th>
                        <th className="px-3 py-2 text-left font-medium text-amber-900">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domainStatus?.dnsRecords?.map((record, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-3 py-2 font-mono text-xs">{record.type}</td>
                          <td className="px-3 py-2 font-mono text-xs">{record.name}</td>
                          <td className="px-3 py-2 font-mono text-xs">{record.value}</td>
                        </tr>
                      )) || (
                        <tr>
                          <td className="px-3 py-2 font-mono text-xs">CNAME</td>
                          <td className="px-3 py-2 font-mono text-xs">{success.store.domain}</td>
                          <td className="px-3 py-2 font-mono text-xs">cname.vercel-dns.com</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-amber-700">
                    DNS changes can take up to 48 hours to propagate.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => checkDomainStatus(success.store.id)}
                    disabled={isCheckingDns}
                  >
                    {isCheckingDns ? 'Checking...' : 'Check DNS'}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-8 flex justify-center gap-4">
              <Link href={`/stores/${success.store.id}`}>
                <Button>View Store</Button>
              </Link>
              <Link href="/stores">
                <Button variant="outline">Back to Stores</Button>
              </Link>
            </div>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Create New Store"
      subtitle="Set up a new store on the platform"
      actions={
        <Link href="/stores">
          <Button variant="outline" size="sm">
            Cancel
          </Button>
        </Link>
      }
    >
      <div className="mx-auto max-w-3xl">
        {/* Progress Steps */}
        <nav className="mb-8">
          <ol className="flex items-center">
            {steps.map((step, index) => (
              <li
                key={step.id}
                className={`flex items-center ${index < steps.length - 1 ? 'flex-1' : ''}`}
              >
                <button
                  onClick={() => index < currentStepIndex && setCurrentStep(step.id)}
                  disabled={index > currentStepIndex}
                  className={`flex items-center ${index <= currentStepIndex ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                >
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-medium ${
                      index < currentStepIndex
                        ? 'border-primary bg-primary text-white'
                        : index === currentStepIndex
                          ? 'border-primary text-primary'
                          : 'border-gray-300 text-gray-500'
                    }`}
                  >
                    {index < currentStepIndex ? (
                      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span
                    className={`ml-3 text-sm font-medium hidden sm:block ${
                      index <= currentStepIndex ? 'text-gray-900' : 'text-gray-500'
                    }`}
                  >
                    {step.name}
                  </span>
                </button>
                {index < steps.length - 1 && (
                  <div
                    className={`ml-4 flex-1 border-t-2 ${
                      index < currentStepIndex ? 'border-primary' : 'border-gray-200'
                    }`}
                  />
                )}
              </li>
            ))}
          </ol>
        </nav>

        {/* Step Content */}
        <div className="rounded-xl border bg-white shadow-sm">
          {/* Step 1: Store Details */}
          {currentStep === 'store' && (
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900">Store Details</h2>
              <p className="mt-1 text-sm text-gray-500">
                Enter the basic information for the new store
              </p>

              <div className="mt-6 space-y-4">
                <div>
                  <label htmlFor="storeName" className="block text-sm font-medium text-gray-700">
                    Store Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="storeName"
                    value={formData.storeName}
                    onChange={e => handleNameChange(e.target.value)}
                    placeholder="My Awesome Store"
                    className={`mt-1 ${validationErrors.storeName ? 'border-red-500' : ''}`}
                  />
                  {validationErrors.storeName && (
                    <p className="mt-1 text-sm text-red-500">{validationErrors.storeName}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="storeSlug" className="block text-sm font-medium text-gray-700">
                    Store URL <span className="text-red-500">*</span>
                  </label>
                  <div
                    className={`mt-1 flex rounded-lg border overflow-hidden ${validationErrors.storeSlug ? 'border-red-500' : ''}`}
                  >
                    <span className="flex items-center bg-gray-50 px-3 text-sm text-gray-500 border-r">
                      https://
                    </span>
                    <input
                      id="storeSlug"
                      type="text"
                      value={formData.storeSlug}
                      onChange={e => {
                        setFormData(prev => ({ ...prev, storeSlug: e.target.value.toLowerCase() }));
                        setValidationErrors(prev => ({ ...prev, storeSlug: '' }));
                      }}
                      placeholder="my-awesome-store"
                      className="flex-1 px-3 py-2 text-sm focus:outline-none"
                    />
                    <span className="flex items-center bg-gray-50 px-3 text-sm text-gray-500 border-l">
                      .forcemediakw.com
                    </span>
                  </div>
                  {validationErrors.storeSlug && (
                    <p className="mt-1 text-sm text-red-500">{validationErrors.storeSlug}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="customDomain" className="block text-sm font-medium text-gray-700">
                    Custom Domain <span className="text-xs text-gray-400">(optional)</span>
                  </label>
                  <Input
                    id="customDomain"
                    value={formData.customDomain}
                    onChange={e =>
                      setFormData(prev => ({ ...prev, customDomain: e.target.value.toLowerCase() }))
                    }
                    placeholder="store.example.com"
                    className="mt-1"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Leave empty to use the default subdomain. Custom domains require DNS
                    configuration.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Owner Details */}
          {currentStep === 'owner' && (
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900">Store Owner</h2>
              <p className="mt-1 text-sm text-gray-500">Set up the owner account for this store</p>

              <div className="mt-6 space-y-4">
                <div>
                  <label htmlFor="ownerName" className="block text-sm font-medium text-gray-700">
                    Owner Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="ownerName"
                    value={formData.ownerName}
                    onChange={e => {
                      setFormData(prev => ({ ...prev, ownerName: e.target.value }));
                      setValidationErrors(prev => ({ ...prev, ownerName: '' }));
                    }}
                    placeholder="John Doe"
                    className={`mt-1 ${validationErrors.ownerName ? 'border-red-500' : ''}`}
                  />
                  {validationErrors.ownerName && (
                    <p className="mt-1 text-sm text-red-500">{validationErrors.ownerName}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="ownerEmail" className="block text-sm font-medium text-gray-700">
                    Email Address <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="ownerEmail"
                    type="email"
                    value={formData.ownerEmail}
                    onChange={e => {
                      setFormData(prev => ({ ...prev, ownerEmail: e.target.value }));
                      setValidationErrors(prev => ({ ...prev, ownerEmail: '' }));
                    }}
                    placeholder="john@example.com"
                    className={`mt-1 ${validationErrors.ownerEmail ? 'border-red-500' : ''}`}
                  />
                  {validationErrors.ownerEmail && (
                    <p className="mt-1 text-sm text-red-500">{validationErrors.ownerEmail}</p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="ownerPassword"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Temporary Password <span className="text-red-500">*</span>
                  </label>
                  <Input
                    id="ownerPassword"
                    type="password"
                    value={formData.ownerPassword}
                    onChange={e => {
                      setFormData(prev => ({ ...prev, ownerPassword: e.target.value }));
                      setValidationErrors(prev => ({ ...prev, ownerPassword: '' }));
                    }}
                    placeholder="Min 8 characters"
                    className={`mt-1 ${validationErrors.ownerPassword ? 'border-red-500' : ''}`}
                  />
                  {validationErrors.ownerPassword && (
                    <p className="mt-1 text-sm text-red-500">{validationErrors.ownerPassword}</p>
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    The owner will be prompted to change this on first login
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Plan Selection */}
          {currentStep === 'plan' && (
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900">Select a Plan</h2>
              <p className="mt-1 text-sm text-gray-500">
                Choose the subscription plan for this store
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {plans.map(plan => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, plan: plan.id }))}
                    className={`relative rounded-xl border-2 p-4 text-left transition ${
                      formData.plan === plan.id
                        ? 'border-primary bg-primary/5'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {plan.popular && <Badge className="absolute -top-2 right-4">Popular</Badge>}
                    <div className="flex items-baseline justify-between">
                      <h3 className="font-semibold text-gray-900">{plan.name}</h3>
                      {formData.plan === plan.id && (
                        <svg
                          className="h-5 w-5 text-primary"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                    <p className="mt-1 text-2xl font-bold text-gray-900">
                      {plan.price === -1 ? 'Custom' : plan.price === 0 ? 'Free' : `$${plan.price}`}
                      {plan.price > 0 && (
                        <span className="text-sm font-normal text-gray-500">/month</span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">{plan.description}</p>
                    <ul className="mt-4 space-y-2">
                      {plan.features.map(feature => (
                        <li key={feature} className="flex items-center text-sm text-gray-600">
                          <svg
                            className="mr-2 h-4 w-4 text-green-500"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {currentStep === 'review' && (
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900">Review & Create</h2>
              <p className="mt-1 text-sm text-gray-500">
                Please review the details before creating the store
              </p>

              <div className="mt-6 space-y-6">
                <div className="rounded-lg bg-gray-50 p-4">
                  <h3 className="flex items-center justify-between font-medium text-gray-900">
                    Store Details
                    <button
                      onClick={() => setCurrentStep('store')}
                      className="text-sm text-primary hover:underline"
                    >
                      Edit
                    </button>
                  </h3>
                  <dl className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Name:</dt>
                      <dd className="font-medium">{formData.storeName}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Default URL:</dt>
                      <dd className="font-medium">{formData.storeSlug}.forcemediakw.com</dd>
                    </div>
                    {formData.customDomain && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Custom Domain:</dt>
                        <dd className="font-medium">{formData.customDomain}</dd>
                      </div>
                    )}
                  </dl>
                </div>

                <div className="rounded-lg bg-gray-50 p-4">
                  <h3 className="flex items-center justify-between font-medium text-gray-900">
                    Store Owner
                    <button
                      onClick={() => setCurrentStep('owner')}
                      className="text-sm text-primary hover:underline"
                    >
                      Edit
                    </button>
                  </h3>
                  <dl className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Name:</dt>
                      <dd className="font-medium">{formData.ownerName}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Email:</dt>
                      <dd className="font-medium">{formData.ownerEmail}</dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-lg bg-gray-50 p-4">
                  <h3 className="flex items-center justify-between font-medium text-gray-900">
                    Selected Plan
                    <button
                      onClick={() => setCurrentStep('plan')}
                      className="text-sm text-primary hover:underline"
                    >
                      Edit
                    </button>
                  </h3>
                  <p className="mt-2 text-sm">
                    <span className="font-medium">
                      {plans.find(p => p.id === formData.plan)?.name}
                    </span>
                    {' - '}
                    {plans.find(p => p.id === formData.plan)?.price === 0
                      ? 'Free'
                      : plans.find(p => p.id === formData.plan)?.price === -1
                        ? 'Custom pricing'
                        : `$${plans.find(p => p.id === formData.plan)?.price}/month`}
                  </p>
                </div>
              </div>

              {error && (
                <div className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-600">{error}</div>
              )}
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between border-t bg-gray-50 px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={prevStep}
              disabled={currentStepIndex === 0}
            >
              Back
            </Button>

            {currentStep === 'review' ? (
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <svg className="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Creating Store...
                  </>
                ) : (
                  'Create Store'
                )}
              </Button>
            ) : (
              <Button onClick={nextStep}>Continue</Button>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
