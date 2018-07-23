'use strict';

const webdriver = require('wd');
const series = require('async/series');
const parallel = require('async/parallel');
const SauceLabs = require('saucelabs');

// status of tests on all platforms
let allPlatformsPassed = true;

// Allow tests to succeed when 0 out of 0 tests pass
let allowZeroAssertions = true;

// amount of time between polling Sauce Labs Job (ms)
let statusPollingInterval = 10000;

// sauce labs account
const account = new SauceLabs({
	username: process.env.SAUCE_USERNAME,
	password: process.env.SAUCE_ACCESS_KEY
});

const DEFAULT_TEST_NAME = 'qunit tests';
const SAUCELABS_URL = `http://${process.env.SAUCE_USERNAME}:${process.env.SAUCE_ACCESS_KEY}@ondemand.saucelabs.com:80/wd/hub`;

const RETRY_ERROR = { type: "RETRY" };
const MAX_RETRIES = 10;
let retryCount = 0;

// https://wiki.saucelabs.com/display/DOCS/Test+Configuration+Options#TestConfigurationOptions-MaximumTestDuration
const PLATFORM_DEFAULTS = {
	maxDuration: 1800, // seconds, default 1800, max 10800
	commandTimeout: 300, // seconds, default 300, max 600
	idleTimeout: 300, // seconds, default 90, max 1000

	// https://wiki.saucelabs.com/display/DOCS/Test+Configuration+Options#TestConfigurationOptions-BuildNumbers
	build: process.env.TRAVIS_JOB_ID,

	// make sure jobs use tunnel provied by sauce_connect
	// https://wiki.saucelabs.com/display/DOCS/Test+Configuration+Options#TestConfigurationOptions-IdentifiedTunnels
	tunnelIdentifier: process.env.TRAVIS_JOB_NUMBER
};

module.exports = function({ urls, platforms, zeroAssertionsPass, runInParallel }) {
	const tests = [];
	const driver = webdriver.remote(SAUCELABS_URL);

	allowZeroAssertions = zeroAssertionsPass === undefined ? allowZeroAssertions : zeroAssertionsPass;

	urls.forEach(urlObj => {
		const testName = urlObj.name || DEFAULT_TEST_NAME;
		const urlPlatforms = urlObj.platforms || platforms;

		urlPlatforms.forEach(platform => {
			tests.push(makeTest({
				driver: driver,
				url: urlObj.url,
				platform: processPlatform(testName, platform)
			}));
		});
	});

	const complete = () => {
		console.log(`\nAll tests completed. Status: ${allPlatformsPassed ? "Passed" : "Failed"}.`);

		driver.quit(() => {
			process.exit(allPlatformsPassed ? 0 : 1);
		});
	};

	if (runInParallel) {
		parallel(tests, complete);
	} else {
		series(tests, complete);
	}
};

function processPlatform(testName, platform) {
	let platformName = '';

	platformName += platform.deviceName ? platform.deviceName + ' ' : '';
	platformName += platform.platform ? platform.platform + ' ' : '';
	platformName += platform.platformName ? platform.platformName + ' ' : '';
	platformName += platform.platformVersion ? platform.platformVersion + ' ' : '';
	platformName += platform.browserName ? platform.browserName + ' ' : '';
	platformName += platform.version ? platform.version + ' ' : '';

	return Object.assign({}, PLATFORM_DEFAULTS, platform, {
		name: `${testName} (${platformName.trim()})`
	});
}

let keepAliveTimeoutId;
function initKeepAlive() {
	// add indicator that drivers are being initialized to keep Travis from timing out
	process.stdout.write('>');
	keepAliveTimeoutId = setTimeout(initKeepAlive, statusPollingInterval);
}

// return a function that will run tests on a given platform
function makeTest({ url, platform, driver }) {
	return function(cb) {
		let jobTimeoutId;

		const testComplete = function(status) {
			if (jobTimeoutId) {
				clearTimeout(jobTimeoutId);
				jobTimeoutId = null;
			}

			// update status of this platform's tests
			driver.sauceJobStatus(status);

			// close the browser
			driver.quit();

			// update status of all tests - process.exit status
			allPlatformsPassed = allPlatformsPassed && status;

			// don't fail the job so that tests will run on other platforms
			cb(null);
		};


		if (!keepAliveTimeoutId) {
			initKeepAlive();
		}

		driver.init(platform, (err, sessionId) => {
			if (err) {
				console.log(`\n${platform.name} driver.init Error: "${err}"`);
				testComplete(false);
				return;
			}

			if (keepAliveTimeoutId) {
				clearTimeout(keepAliveTimeoutId);
				keepAliveTimeoutId = null;
			}

			console.log(`\n${platform.name} Job URL: https://saucelabs.com/jobs/${sessionId}`);

			const pollSauceLabsStatus = function() {
				account.showJob(sessionId, (err, job) => {
					if (err) {
						console.log(`\n${platform.name} account.showJob Error: "${err}"`);
						return;
					}

					if (job.error) {
						console.log(`\n${platform.name} job Error: "${job.error}"`);
						testComplete(false);
						return;
					}

					// add indicator that tests are running to keep Travis from timing out
					process.stdout.write('.');

					jobTimeoutId = setTimeout(pollSauceLabsStatus, statusPollingInterval);
				});
			};

			driver.get(url);

			const getElementText = function(selector) {
				const timeout = platform.idleTimeout * 1000;
				const pollingFrequency = 2000;

				return function(callback) {
					driver
						.waitForElementsByCssSelector(selector, timeout, pollingFrequency, (err, el) => {
							if (err) {
								console.log(`\nwaitForElementsByCssSelector Error: "${err}"`);
								return callback(err);
							}

							driver.text(el, (err, text) => {
								// handle expected StaleElementReference error by retrying
								if(err && err.cause && err.cause.value["class"] === "org.openqa.selenium.StaleElementReferenceException") {
									return cb(RETRY_ERROR);
								}
								callback(err ? err : null, text);
							});
						});
				};
			};

			const checkTestResults = function() {
				series([
					getElementText('#qunit-testresult .passed'),
					getElementText('#qunit-testresult .failed'),
					getElementText('#qunit-testresult .total')
				], (err, [passed, failed, total]) => {
					if (err) {
						if (err === RETRY_ERROR && retryCount++ < MAX_RETRIES) {
							console.log(`StaleElementReference Error. Retrying. Retry Count: ${retryCount}.`);
							setTImeout(checkTestResults, 2000);
							return;
						}

						console.log(`\n${platform.name} test results Error: "${err}"`);
						testComplete(false);
						return;
					}

					const allTestsPassed = (passed === total && failed === "0" && (total !== '0' || allowZeroAssertions));

					console.log(`\n${platform.name} Results: ${allTestsPassed ? "Passed" : "Failed"} (${passed} / ${total}).`);
					testComplete(allTestsPassed);
				});
			};

			pollSauceLabsStatus();
			checkTestResults();
		});
	};
}
