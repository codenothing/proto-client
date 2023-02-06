import type {
  EndpointMatcher,
  RequestOptions,
  RequestRetryOptions,
} from "./interfaces";

/**
 * Generates a function for matching namespaces to requests
 * @param match Multi-type endpoint matcher to convert
 * @returns Matcher function
 */
export const generateEndpointMatcher = (
  match?: string | RegExp | EndpointMatcher
): EndpointMatcher => {
  if (!match) {
    return () => true;
  } else if (typeof match === "string") {
    if (/\.\*$/.test(match)) {
      const matchNamespace = match.replace(/\*$/, "");
      return (method) => method.startsWith(matchNamespace);
    } else {
      return (method) => method === match;
    }
  } else if (match instanceof RegExp) {
    return (method) => match.test(method);
  } else {
    return match;
  }
};

/**
 * Normalizes provided retry options into configuration object
 * @param options Various retry option types
 */
export const normalizeRetryOptions = (
  options: RequestOptions["retryOptions"]
): RequestRetryOptions | void => {
  if (options !== undefined) {
    if (options === true) {
      return { retryCount: 1 };
    } else if (options === false) {
      return { retryCount: 0 };
    } else if (typeof options === "number") {
      return { retryCount: options };
    } else {
      return options;
    }
  }
};
