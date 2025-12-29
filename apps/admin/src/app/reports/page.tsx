'use client';

import { useState } from 'react';

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
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Reports</h1>
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2"
        >
          <option value="today">Today</option>
          <option value="last7days">Last 7 Days</option>
          <option value="last30days">Last 30 Days</option>
          <option value="last90days">Last 90 Days</option>
          <option value="thisYear">This Year</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {reports.map((report) => (
          <div
            key={report.name}
            className="bg-white rounded-lg shadow p-6 hover:shadow-lg transition-shadow cursor-pointer"
          >
            <div className="text-4xl mb-4">{report.icon}</div>
            <h3 className="text-lg font-semibold mb-2">{report.name}</h3>
            <p className="text-gray-600 text-sm mb-4">{report.description}</p>
            <div className="flex space-x-2">
              <button className="text-blue-600 hover:text-blue-800 text-sm">View</button>
              <button className="text-gray-600 hover:text-gray-800 text-sm">Export</button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4">Quick Stats</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-blue-50 rounded-lg">
            <div className="text-3xl font-bold text-blue-600">$12,450</div>
            <div className="text-sm text-gray-600">Total Revenue</div>
          </div>
          <div className="text-center p-4 bg-green-50 rounded-lg">
            <div className="text-3xl font-bold text-green-600">156</div>
            <div className="text-sm text-gray-600">Orders</div>
          </div>
          <div className="text-center p-4 bg-purple-50 rounded-lg">
            <div className="text-3xl font-bold text-purple-600">89</div>
            <div className="text-sm text-gray-600">New Customers</div>
          </div>
          <div className="text-center p-4 bg-orange-50 rounded-lg">
            <div className="text-3xl font-bold text-orange-600">3.2%</div>
            <div className="text-sm text-gray-600">Conversion Rate</div>
          </div>
        </div>
      </div>
    </div>
  );
}
