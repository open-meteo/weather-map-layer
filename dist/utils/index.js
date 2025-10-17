const now = /* @__PURE__ */ new Date();
now.setHours(now.getHours() + 1, 0, 0, 0);
const pad = (n) => {
  return ("0" + n).slice(-2);
};
const closestDomainInterval = (time, domain) => {
  let newTime = new Date(time.getTime());
  if (domain.time_interval > 1) {
    if (time.getUTCHours() % domain.time_interval > 0) {
      const closestUTCHour = time.getUTCHours() - time.getUTCHours() % domain.time_interval;
      newTime.setUTCHours(closestUTCHour + domain.time_interval);
    }
  }
  return newTime;
};
const closestModelRun = (domain, selectedTime, latest) => {
  const year = selectedTime.getUTCFullYear();
  const month = selectedTime.getUTCMonth();
  const date = selectedTime.getUTCDate();
  const closestModelRunUTCHour = selectedTime.getUTCHours() - selectedTime.getUTCHours() % domain.model_interval;
  const closestModelRun2 = /* @__PURE__ */ new Date();
  closestModelRun2.setUTCFullYear(year);
  closestModelRun2.setUTCMonth(month);
  closestModelRun2.setUTCDate(date);
  closestModelRun2.setUTCHours(closestModelRunUTCHour);
  closestModelRun2.setUTCMinutes(0);
  closestModelRun2.setUTCSeconds(0);
  closestModelRun2.setUTCMilliseconds(0);
  return closestModelRun2;
};
const getOMUrl = (time, mode, partial, domain, variable, modelRun, paddedBounds) => {
  if (paddedBounds) {
    return `https://map-tiles.open-meteo.com/data_spatial/${domain.value}/${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())}T${pad(time.getUTCHours())}00.om?dark=${mode === "dark"}&variable=${variable.value}&partial=${partial}&bounds=${paddedBounds.getSouth()},${paddedBounds.getWest()},${paddedBounds.getNorth()},${paddedBounds.getEast()}`;
  } else {
    return `https://map-tiles.open-meteo.com/data_spatial/${domain.value}/${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${time.getUTCFullYear()}-${pad(time.getUTCMonth() + 1)}-${pad(time.getUTCDate())}T${pad(time.getUTCHours())}00.om?dark=${mode === "dark"}&variable=${variable.value}&partial=${partial}`;
  }
};
export {
  closestDomainInterval,
  closestModelRun,
  getOMUrl,
  pad
};
