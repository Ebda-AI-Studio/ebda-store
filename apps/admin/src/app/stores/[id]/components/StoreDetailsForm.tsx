'use client';

import { Badge, Input, Label } from '@force/ui';
import { Button } from '@force/ui';
import { formatDate } from '../../../../lib/format';

interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

const statusColors = {
  active: 'default',
  inactive: 'secondary',
  suspended: 'destructive',
} as const;

interface StoreDetailsFormProps {
  store: Store;
  isEditing: boolean;
  isSaving: boolean;
  editForm: { name: string; slug: string; plan: string; status: string };
  formErrors: { name?: string; slug?: string };
  onEditFormChange: (form: { name: string; slug: string; plan: string; status: string }) => void;
  onFormErrorsClear: (field: 'name' | 'slug') => void;
  onSave: () => void;
  onCancelEdit: () => void;
}

export function StoreDetailsForm({
  store,
  isEditing,
  isSaving,
  editForm,
  formErrors,
  onEditFormChange,
  onFormErrorsClear,
  onSave,
  onCancelEdit,
}: StoreDetailsFormProps) {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-3">
      {/* Store Details */}
      <div className="lg:col-span-2 rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-foreground">Store Details</h2>
          {isEditing && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onCancelEdit}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSave} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          )}
        </div>
        <div className="p-6 space-y-4">
          {isEditing ? (
            <>
              <div>
                <Label htmlFor="name">Store Name</Label>
                <Input
                  id="name"
                  value={editForm.name}
                  onChange={e => {
                    onEditFormChange({ ...editForm, name: e.target.value });
                    if (formErrors.name) onFormErrorsClear('name');
                  }}
                  className={`mt-1 ${formErrors.name ? 'border-destructive focus:border-destructive focus:ring-red-500' : ''}`}
                />
                {formErrors.name && (
                  <p className="mt-1 text-sm text-destructive">{formErrors.name}</p>
                )}
              </div>
              <div>
                <Label htmlFor="slug">URL Slug</Label>
                <Input
                  id="slug"
                  value={editForm.slug}
                  onChange={e => {
                    const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                    onEditFormChange({ ...editForm, slug: value });
                    if (formErrors.slug) onFormErrorsClear('slug');
                  }}
                  className={`mt-1 ${formErrors.slug ? 'border-destructive focus:border-destructive focus:ring-red-500' : ''}`}
                  placeholder="my-store-name"
                />
                {formErrors.slug && (
                  <p className="mt-1 text-sm text-destructive">{formErrors.slug}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Your store will be at: {editForm.slug || 'your-slug'}.forcemediakw.com
                </p>
              </div>
              <div>
                <Label htmlFor="plan">Plan</Label>
                <select
                  id="plan"
                  value={editForm.plan}
                  onChange={e => onEditFormChange({ ...editForm, plan: e.target.value })}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="free">Free</option>
                  <option value="starter">Starter</option>
                  <option value="professional">Professional</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  value={editForm.status}
                  onChange={e => onEditFormChange({ ...editForm, status: e.target.value })}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Store Name</p>
                <p className="font-medium text-foreground">{store.name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">URL</p>
                <p className="font-medium text-foreground">
                  {store.domain || `${store.slug}.forcemediakw.com`}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <Badge variant={statusColors[store.status]} className="mt-1">
                  {store.status}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Plan</p>
                <p className="font-medium text-foreground capitalize">{store.plan}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p className="font-medium text-foreground">{formatDate(store.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Last Updated</p>
                <p className="font-medium text-foreground">{formatDate(store.updatedAt)}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Owner Info */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">Store Owner</h2>
        </div>
        <div className="p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <span className="text-lg font-bold">
                {store.owner.firstName[0]}
                {store.owner.lastName[0]}
              </span>
            </div>
            <div>
              <p className="font-medium text-foreground">
                {store.owner.firstName} {store.owner.lastName}
              </p>
              <p className="text-sm text-muted-foreground">{store.owner.email}</p>
            </div>
          </div>
          <div className="mt-6 space-y-2">
            <a href={`/users/${store.owner.id}`}>
              <Button variant="outline" size="sm" className="w-full">
                View Profile
              </Button>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
