'use client';

import { useState } from 'react';
import { AdminLayout } from '../../components/AdminLayout';

export default function ReportsPage() {
  const [dateRange, setDateRange] = useState('last7days');

  const reports = [
    { name: 'Sales Report', description: 'Daily, weekly, and monthly sales data', icon: '📊' },
    { name: 'Product Performance', description: 'Best and worst selling products', icon: '📈' },
    { name: 'Customer Analytics', description: 'Customer acquisition and retention', icon: '👥' },
    { name: 'Inventory Report', description: 'Stock levels and reorder alerts', icon: '📦' },
    { name: 'Revenue Report', description: 'Revenue breakdown by category', icon: '💰' },
    { name: 'Traffic Report', description: 'Website traffic and conversion rates', icon: '🌐' },
  ];

  return (
    <AdminLayout
      title="Reports"
      subtitle="Analytics and insights across all stores"
      actions={
        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          className="rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="today">Today</option>
          <option value="last7days">Last 7 Days</option>
          <option value="last30days">Last 30 Days</option>
          <option value="last90days">Last 90 Days</option>
          <option value="thisYear">This Year</option>
        </select>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {reports.map(report => (
          <div
            key={report.name}
            className="force-card p-6 hover:shadow-lg transition-shadow cursor-pointer group"
          >
            <div className="text-4xl mb-4">{report.icon}</div>
            <h3 className="text-lg font-semibold mb-2 group-hover:text-primary transition-colors">
              {report.name}
            </h3>
            <p className="text-muted-foreground text-sm mb-4">{report.description}</p>
            <div className="flex space-x-4">
              <button className="text-primary hover:text-primary/80 text-sm font-medium">
                View
              </button>
              <button className="text-muted-foreground hover:text-foreground text-sm">
                Export
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 force-card p-6">
        <h2 className="text-xl font-semibold mb-4">Quick Stats</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-blue-50 rounded-xl">
            <div className="text-3xl font-bold text-blue-600">$12,450</div>
            <div className="text-sm text-muted-foreground">Total Revenue</div>
          </div>
          <div className="text-center p-4 bg-emerald-50 rounded-xl">
            <div className="text-3xl font-bold text-emerald-600">156</div>
            <div className="text-sm text-muted-foreground">Orders</div>
          </div>
          <div className="text-center p-4 bg-violet-50 rounded-xl">
            <div className="text-3xl font-bold text-violet-600">89</div>
            <div className="text-sm text-muted-foreground">New Customers</div>
          </div>
          <div className="text-center p-4 bg-orange-50 rounded-xl">
            <div className="text-3xl font-bold text-primary">3.2%</div>
            <div className="text-sm text-muted-foreground">Conversion Rate</div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
