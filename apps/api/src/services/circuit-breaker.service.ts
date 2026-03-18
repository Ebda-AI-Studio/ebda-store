/**
 * Circuit Breaker Service
 * Prevents cascade failures when external services are down
 */

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number; // Number of failures before opening
  successThreshold: number; // Number of successes in half-open before closing
  timeout: number; // Time in ms before trying again (half-open)
  resetTimeout?: number; // Time in ms to reset failure count
}

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number;
  nextAttempt: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30000, // 30 seconds
  resetTimeout: 60000, // 1 minute
};

export class CircuitBreakerRegistry {
  private circuits: Map<string, CircuitBreakerState> = new Map();
  private options: Map<string, CircuitBreakerOptions> = new Map();

  register(name: string, options: Partial<CircuitBreakerOptions> = {}): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.options.set(name, opts);
    this.circuits.set(name, {
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      lastFailure: 0,
      nextAttempt: 0,
    });
  }

  getState(name: string): CircuitBreakerState | undefined {
    return this.circuits.get(name);
  }

  private getOptions(name: string): CircuitBreakerOptions {
    return this.options.get(name) || DEFAULT_OPTIONS;
  }

  /**
   * Check if we can make a request through the circuit
   */
  canRequest(name: string): boolean {
    const circuit = this.circuits.get(name);
    if (!circuit) return true; // If not registered, allow

    const now = Date.now();

    switch (circuit.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if timeout has passed
        if (now >= circuit.nextAttempt) {
          // Transition to half-open
          circuit.state = 'HALF_OPEN';
          circuit.successes = 0;
          return true;
        }
        return false;

      case 'HALF_OPEN':
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(name: string): void {
    const circuit = this.circuits.get(name);
    if (!circuit) return;

    const opts = this.getOptions(name);

    switch (circuit.state) {
      case 'HALF_OPEN':
        circuit.successes++;
        if (circuit.successes >= opts.successThreshold) {
          // Transition to closed
          circuit.state = 'CLOSED';
          circuit.failures = 0;
          circuit.successes = 0;
          logger.info({ circuit: name }, '[CIRCUIT] HALF_OPEN -> CLOSED');
        }
        break;

      case 'CLOSED':
        // Reset failure count on success
        circuit.failures = 0;
        break;
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(name: string): void {
    const circuit = this.circuits.get(name);
    if (!circuit) return;

    const opts = this.getOptions(name);
    const now = Date.now();

    // Reset failures if resetTimeout has passed
    if (opts.resetTimeout && now - circuit.lastFailure > opts.resetTimeout) {
      circuit.failures = 0;
    }

    circuit.failures++;
    circuit.lastFailure = now;

    switch (circuit.state) {
      case 'CLOSED':
        if (circuit.failures >= opts.failureThreshold) {
          // Transition to open
          circuit.state = 'OPEN';
          circuit.nextAttempt = now + opts.timeout;
          logger.warn(
            { circuit: name, nextAttempt: new Date(circuit.nextAttempt).toISOString() },
            '[CIRCUIT] CLOSED -> OPEN'
          );
        }
        break;

      case 'HALF_OPEN':
        // Any failure in half-open goes back to open
        circuit.state = 'OPEN';
        circuit.nextAttempt = now + opts.timeout;
        logger.warn({ circuit: name }, '[CIRCUIT] HALF_OPEN -> OPEN');
        break;
    }
  }

  /**
   * Get all circuit states for monitoring
   */
  getAllStates(): Record<string, CircuitBreakerState> {
    const states: Record<string, CircuitBreakerState> = {};
    this.circuits.forEach((state, name) => {
      states[name] = { ...state };
    });
    return states;
  }

  /**
   * Reset a specific circuit to closed state (for testing)
   */
  reset(name: string): void {
    const circuit = this.circuits.get(name);
    if (circuit) {
      circuit.state = 'CLOSED';
      circuit.failures = 0;
      circuit.successes = 0;
      circuit.lastFailure = 0;
      circuit.nextAttempt = 0;
    }
  }

  /**
   * Clear all circuits (for testing)
   */
  clear(): void {
    this.circuits.clear();
    this.options.clear();
  }
}

// Singleton instance
export const circuitBreaker = new CircuitBreakerRegistry();

// Register default circuits
circuitBreaker.register('payment-tap', { failureThreshold: 3, timeout: 60000 });
circuitBreaker.register('payment-myfatoorah', { failureThreshold: 3, timeout: 60000 });
circuitBreaker.register('payment-hesabe', { failureThreshold: 3, timeout: 60000 });
circuitBreaker.register('payment-upayments', { failureThreshold: 3, timeout: 60000 });
circuitBreaker.register('email', { failureThreshold: 5, timeout: 30000 });
circuitBreaker.register('sms', { failureThreshold: 5, timeout: 30000 });
circuitBreaker.register('storage', { failureThreshold: 5, timeout: 30000 });
circuitBreaker.register('ai', { failureThreshold: 3, timeout: 60000 });

/**
 * Decorator function to wrap async operations with circuit breaker
 */
export async function withCircuitBreaker<T>(
  name: string,
  operation: () => Promise<T>,
  fallback?: () => T | Promise<T>
): Promise<T> {
  if (!circuitBreaker.canRequest(name)) {
    logger.warn({ circuit: name }, '[CIRCUIT] Circuit is OPEN, request blocked');
    if (fallback) {
      return fallback();
    }
    throw new Error(`Service ${name} is temporarily unavailable`);
  }

  try {
    const result = await operation();
    circuitBreaker.recordSuccess(name);
    return result;
  } catch (error) {
    circuitBreaker.recordFailure(name);
    if (fallback) {
      logger.warn({ circuit: name }, '[CIRCUIT] Operation failed, using fallback');
      return fallback();
    }
    throw error;
  }
}

/**
 * Circuit breaker middleware for Express
 */
export function circuitBreakerMiddleware(name: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!circuitBreaker.canRequest(name)) {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service temporarily unavailable. Please try again later.',
        },
      });
      return;
    }
    next();
  };
}
