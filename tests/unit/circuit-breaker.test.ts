/**
 * Circuit Breaker Unit Tests
 * Tests circuit breaker pattern implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  circuitBreaker,
  CircuitBreakerRegistry,
  withCircuitBreaker,
} from '@api/services/circuit-breaker.service';

// Create a fresh instance for testing
let testRegistry: CircuitBreakerRegistry;

describe('Circuit Breaker Service', () => {
  beforeEach(() => {
    // Create fresh registry for each test
    testRegistry = new (CircuitBreakerRegistry as any)();
  });

  describe('Registration', () => {
    it('should register a new circuit', () => {
      testRegistry.register('test-service');
      const state = testRegistry.getState('test-service');

      expect(state).toBeDefined();
      expect(state?.state).toBe('CLOSED');
      expect(state?.failures).toBe(0);
    });

    it('should register with custom options', () => {
      testRegistry.register('custom-service', {
        failureThreshold: 3,
        timeout: 60000,
      });

      const state = testRegistry.getState('custom-service');
      expect(state).toBeDefined();
    });
  });

  describe('State Transitions', () => {
    beforeEach(() => {
      testRegistry.register('test-service', {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 100, // Very short for testing
      });
    });

    it('should start in CLOSED state', () => {
      expect(testRegistry.getState('test-service')?.state).toBe('CLOSED');
    });

    it('should allow requests when CLOSED', () => {
      expect(testRegistry.canRequest('test-service')).toBe(true);
    });

    it('should transition to OPEN after threshold failures', () => {
      // Record failures up to threshold
      testRegistry.recordFailure('test-service');
      testRegistry.recordFailure('test-service');
      testRegistry.recordFailure('test-service');

      expect(testRegistry.getState('test-service')?.state).toBe('OPEN');
    });

    it('should block requests when OPEN', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        testRegistry.recordFailure('test-service');
      }

      expect(testRegistry.canRequest('test-service')).toBe(false);
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        testRegistry.recordFailure('test-service');
      }
      expect(testRegistry.getState('test-service')?.state).toBe('OPEN');

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should now allow request and be in HALF_OPEN
      expect(testRegistry.canRequest('test-service')).toBe(true);
      expect(testRegistry.getState('test-service')?.state).toBe('HALF_OPEN');
    });

    it('should transition to CLOSED after success threshold in HALF_OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        testRegistry.recordFailure('test-service');
      }

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 150));
      testRegistry.canRequest('test-service'); // Triggers HALF_OPEN

      // Record successes
      testRegistry.recordSuccess('test-service');
      testRegistry.recordSuccess('test-service');

      expect(testRegistry.getState('test-service')?.state).toBe('CLOSED');
    });

    it('should transition back to OPEN on failure in HALF_OPEN', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        testRegistry.recordFailure('test-service');
      }

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 150));
      testRegistry.canRequest('test-service'); // Triggers HALF_OPEN

      // Record failure
      testRegistry.recordFailure('test-service');

      expect(testRegistry.getState('test-service')?.state).toBe('OPEN');
    });
  });

  describe('Success Recording', () => {
    beforeEach(() => {
      testRegistry.register('test-service', { failureThreshold: 3 });
    });

    it('should reset failure count on success', () => {
      testRegistry.recordFailure('test-service');
      testRegistry.recordFailure('test-service');
      expect(testRegistry.getState('test-service')?.failures).toBe(2);

      testRegistry.recordSuccess('test-service');
      expect(testRegistry.getState('test-service')?.failures).toBe(0);
    });
  });

  describe('Unregistered Services', () => {
    it('should allow requests for unregistered services', () => {
      expect(testRegistry.canRequest('unregistered-service')).toBe(true);
    });

    it('should handle success/failure for unregistered services gracefully', () => {
      expect(() => testRegistry.recordSuccess('unregistered')).not.toThrow();
      expect(() => testRegistry.recordFailure('unregistered')).not.toThrow();
    });
  });

  describe('getAllStates', () => {
    it('should return all circuit states', () => {
      testRegistry.register('service-1');
      testRegistry.register('service-2');

      const states = testRegistry.getAllStates();

      expect(states['service-1']).toBeDefined();
      expect(states['service-2']).toBeDefined();
    });
  });
});

describe('withCircuitBreaker Wrapper', () => {
  beforeEach(() => {
    // Register test circuit on global instance
    circuitBreaker.register('test-wrapper', {
      failureThreshold: 2,
      successThreshold: 1,
      timeout: 100,
    });
    // Reset to closed state
    circuitBreaker.recordSuccess('test-wrapper');
  });

  it('should execute operation successfully', async () => {
    const mockOperation = vi.fn().mockResolvedValue('success');

    const result = await withCircuitBreaker('test-wrapper', mockOperation);

    expect(result).toBe('success');
    expect(mockOperation).toHaveBeenCalledTimes(1);
  });

  it('should record success on successful operation', async () => {
    const mockOperation = vi.fn().mockResolvedValue('success');

    await withCircuitBreaker('test-wrapper', mockOperation);

    expect(circuitBreaker.getState('test-wrapper')?.failures).toBe(0);
  });

  it('should record failure on failed operation', async () => {
    const mockOperation = vi.fn().mockRejectedValue(new Error('Failed'));

    await expect(withCircuitBreaker('test-wrapper', mockOperation)).rejects.toThrow('Failed');

    expect(circuitBreaker.getState('test-wrapper')?.failures).toBeGreaterThan(0);
  });

  it('should use fallback when provided and operation fails', async () => {
    const mockOperation = vi.fn().mockRejectedValue(new Error('Failed'));
    const mockFallback = vi.fn().mockReturnValue('fallback-value');

    const result = await withCircuitBreaker('test-wrapper', mockOperation, mockFallback);

    expect(result).toBe('fallback-value');
    expect(mockFallback).toHaveBeenCalledTimes(1);
  });

  it('should use fallback when circuit is open', async () => {
    // Open the circuit
    circuitBreaker.recordFailure('test-wrapper');
    circuitBreaker.recordFailure('test-wrapper');

    const mockOperation = vi.fn().mockResolvedValue('success');
    const mockFallback = vi.fn().mockReturnValue('fallback-value');

    const result = await withCircuitBreaker('test-wrapper', mockOperation, mockFallback);

    expect(result).toBe('fallback-value');
    expect(mockOperation).not.toHaveBeenCalled();
    expect(mockFallback).toHaveBeenCalledTimes(1);
  });

  it('should throw when circuit is open and no fallback', async () => {
    // Open the circuit
    circuitBreaker.recordFailure('test-wrapper');
    circuitBreaker.recordFailure('test-wrapper');

    const mockOperation = vi.fn().mockResolvedValue('success');

    await expect(withCircuitBreaker('test-wrapper', mockOperation)).rejects.toThrow(
      'temporarily unavailable'
    );
    expect(mockOperation).not.toHaveBeenCalled();
  });
});

describe('Pre-registered Circuits', () => {
  it('should have payment circuits registered', () => {
    expect(circuitBreaker.getState('payment-tap')).toBeDefined();
    expect(circuitBreaker.getState('payment-myfatoorah')).toBeDefined();
    expect(circuitBreaker.getState('payment-hesabe')).toBeDefined();
    expect(circuitBreaker.getState('payment-upayments')).toBeDefined();
  });

  it('should have email circuit registered', () => {
    expect(circuitBreaker.getState('email')).toBeDefined();
  });

  it('should have storage circuit registered', () => {
    expect(circuitBreaker.getState('storage')).toBeDefined();
  });

  it('should have AI circuit registered', () => {
    expect(circuitBreaker.getState('ai')).toBeDefined();
  });
});
