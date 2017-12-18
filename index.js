'use strict';

var webdriver = require('wd');
var series = require('async/series');
var SauceLabs = require('saucelabs');

// status of tests on all platforms
var allPlatformsPassed = true;

// Allow tests to succeed when 0 out of 0 tests pass
var allowZeroAssertions = true;

// amount of time between polling Sauce Labs Job (ms)
var statusPollingInterval = 10000;

// sauce labs account
var account = new SauceLabs({
	username: process.env.SAUCE_USERNAME,
	password: process.env.SAUCE_ACCESS_KEY
});

const DEFAULT_TEST_NAME = 'qunit tests';
const SAUCELABS_URL = `http://${process.env.SAUCE_USERNAME}:${process.env.SAUCE_ACCESS_KEY}@ondemand.saucelabs.com:80/wd/hub`;

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

module.exports = function({ urls, platforms, zeroAssertionsPass }) {
	var tests = [];
	allowZeroAssertions = zeroAssertionsPass === undefined ? allowZeroAssertions : zeroAssertionsPass;
	var driver = webdriver.remote(SAUCELABS_URL);

	urls.forEach(urlObj => {
		var testName = urlObj.name || DEFAULT_TEST_NAME;
		var urlPlatforms = urlObj.platforms || platforms;

		urlPlatforms.forEach(platform => {
			tests.push(makeTest({
				driver: driver,
				url: urlObj.url,
				platform: processPlatform(testName, platform)
			}));
		});
	});

	series(tests, () => {
		console.log(`All tests completed with status ${allPlatformsPassed}`);

		driver.quit(() => {
			process.exit(allPlatformsPassed ? 0 : 1);
		});
	});
};

function processPlatform(testName, platform) {
	var name = `${testName} - `;

	name += platform.deviceName ? platform.deviceName + ' ' : '';
	name += platform.platform ? platform.platform + ' ' : '';
	name += platform.platformName ? platform.platformName + ' ' : '';
	name += platform.platformVersion ? platform.platformVersion + ' ' : '';
	name += platform.browserName ? platform.browserName + ' ' : '';
	name += platform.version ? platform.version + ' ' : '';

	return Object.assign({}, PLATFORM_DEFAULTS, platform, {
		name: name,
	});
}

// return a function that will run tests on a given platform
function makeTest({ url, platform, driver }) {
	return function(cb) {
		var jobTimeoutId, initTimeoutId;

		console.log(`Running ${platform.name}`);

		var testComplete = function(status) {
			if (jobTimeoutId) {
				clearTimeout(jobTimeoutId);
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

		var initKeepAlive = function() {
			// add indicator that driver is being initialized to keep Travis from timing out
			process.stdout.write('>');

			initTimeoutId = setTimeout(initKeepAlive, statusPollingInterval);
		};

		initKeepAlive();

		driver.init(platform, (err, sessionId) => {
			if (err) {
				console.log(`Error calling driver.init: ${err}`);
				testComplete(false);
				return;
			}
			console.log(`\nSauce Labs Job: https://saucelabs.com/jobs/${sessionId}`);

			if (initTimeoutId) {
				clearTimeout(initTimeoutId);
			}

			var pollSauceLabsStatus = function() {
				account.showJob(sessionId, (err, job) => {
					if (err) {
						console.log(`\nError calling account.showJob: ${err}`);
						return;
					}

					if (job.error) {
						console.log(`\nJob Error: ${job.error}`);
						testComplete(false);
						return;
					}

					// add indicator that tests are running to keep Travis from timing out
					process.stdout.write('.');

					jobTimeoutId = setTimeout(pollSauceLabsStatus, statusPollingInterval);
				});
			};

			console.log(`Opening: ${url}`);
			driver.get(url);

			var getElementText = function(selector) {
				var timeout = platform.idleTimeout * 1000;
				var pollingFrequency = 2000;

				return function(callback) {
					driver
						.waitForElementsByCssSelector(selector, timeout, pollingFrequency, (err, el) => {
							if (err) {
								return callback(err);
							}

							driver.text(el, (err, text) => {
								callback(err ? err : null, text);
							});
						});
				};
			};

			var checkTestResults = function() {
				series([
					getElementText('#qunit-testresult .passed'),
					getElementText('#qunit-testresult .failed'),
					getElementText('#qunit-testresult .total')
				], (err, [passed, failed, total]) => {
					if (err) {
						console.log(`\nError checking test results: ${err}`);
						testComplete(false);
						return;
					}

					var allTestsPassed = (passed === total && failed === "0" && (total !== '0' || allowZeroAssertions));

					console.log(`\nPassed: ${allTestsPassed} (${passed} / ${total})\n`);
					testComplete(allTestsPassed);
				});
			};

			pollSauceLabsStatus();
			checkTestResults();
		});
	};
}
