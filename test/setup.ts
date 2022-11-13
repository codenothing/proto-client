beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.resetAllMocks();
  jest.restoreAllMocks();
  jest.clearAllTimers();
});
