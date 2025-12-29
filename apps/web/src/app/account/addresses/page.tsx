'use client';

import { useState } from 'react';
import { Button, Input } from '@force/ui';

interface Address {
  id: string;
  name: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  isDefault: boolean;
}

export default function AddressesPage() {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    street: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'Kuwait',
    phone: '',
    isDefault: false,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const newAddress: Address = {
      id: `addr_${Date.now()}`,
      ...formData,
    };
    setAddresses([...addresses, newAddress]);
    setIsAdding(false);
    setFormData({
      name: '',
      street: '',
      city: '',
      state: '',
      postalCode: '',
      country: 'Kuwait',
      phone: '',
      isDefault: false,
    });
  }

  function handleDelete(id: string) {
    setAddresses(addresses.filter(a => a.id !== id));
  }

  function handleSetDefault(id: string) {
    setAddresses(addresses.map(a => ({ ...a, isDefault: a.id === id })));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Saved Addresses</h1>
          <p className="mt-1 text-gray-500">Manage your delivery addresses</p>
        </div>
        {!isAdding && (
          <Button onClick={() => setIsAdding(true)}>
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Address
          </Button>
        )}
      </div>

      {isAdding && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Add New Address</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Full Name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                required
              />
              <Input
                label="Phone Number"
                type="tel"
                value={formData.phone}
                onChange={e => setFormData({ ...formData, phone: e.target.value })}
                required
              />
            </div>

            <Input
              label="Street Address"
              value={formData.street}
              onChange={e => setFormData({ ...formData, street: e.target.value })}
              required
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="City"
                value={formData.city}
                onChange={e => setFormData({ ...formData, city: e.target.value })}
                required
              />
              <Input
                label="State / Area"
                value={formData.state}
                onChange={e => setFormData({ ...formData, state: e.target.value })}
                required
              />
              <Input
                label="Postal Code"
                value={formData.postalCode}
                onChange={e => setFormData({ ...formData, postalCode: e.target.value })}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Country</label>
              <select
                value={formData.country}
                onChange={e => setFormData({ ...formData, country: e.target.value })}
                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="Kuwait">Kuwait</option>
                <option value="Saudi Arabia">Saudi Arabia</option>
                <option value="UAE">United Arab Emirates</option>
                <option value="Bahrain">Bahrain</option>
                <option value="Qatar">Qatar</option>
                <option value="Oman">Oman</option>
              </select>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={e => setFormData({ ...formData, isDefault: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <span className="text-sm text-gray-700">Set as default address</span>
            </label>

            <div className="flex gap-2 pt-4">
              <Button type="submit">Save Address</Button>
              <Button type="button" variant="outline" onClick={() => setIsAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {addresses.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {addresses.map(address => (
            <div
              key={address.id}
              className={`relative rounded-xl border bg-white p-6 shadow-sm ${
                address.isDefault ? 'border-primary' : ''
              }`}
            >
              {address.isDefault && (
                <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  Default
                </span>
              )}
              <p className="font-medium text-gray-900">{address.name}</p>
              <p className="mt-1 text-sm text-gray-600">{address.street}</p>
              <p className="text-sm text-gray-600">
                {address.city}, {address.state} {address.postalCode}
              </p>
              <p className="text-sm text-gray-600">{address.country}</p>
              <p className="mt-2 text-sm text-gray-500">{address.phone}</p>

              <div className="mt-4 flex gap-2">
                {!address.isDefault && (
                  <button
                    onClick={() => handleSetDefault(address.id)}
                    className="text-sm text-primary hover:underline"
                  >
                    Set as Default
                  </button>
                )}
                <button
                  onClick={() => handleDelete(address.id)}
                  className="text-sm text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !isAdding ? (
        <div className="rounded-xl border bg-white p-12 text-center shadow-sm">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No addresses saved</h3>
          <p className="mt-2 text-gray-500">Add an address for faster checkout.</p>
          <Button onClick={() => setIsAdding(true)} className="mt-6">
            Add Your First Address
          </Button>
        </div>
      ) : null}
    </div>
  );
}
